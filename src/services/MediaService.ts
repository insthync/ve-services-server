import winston from "winston";
import express from "express";
import fileupload from 'express-fileupload'
import { PrismaClient } from '@prisma/client'
import { nanoid } from "nanoid";
import { getVideoDurationInSeconds } from 'get-video-duration'
import { Client } from "colyseus";
import { MediaRoom } from "../rooms/MediaRoom";

export class MediaService {
    private app: express.Express;
    private logger: winston.Logger;
    private prisma: PrismaClient;
    private playLists: { [id: string]: IMediaData } = {}
    private playListSubscribers: { [id: string]: Client[] } = {}
    private deletingMediaIds: string[] = []
    private connectingUsers: { [id: string]: IClientData } = {}
    private connections: { [id: string]: Client } = {}

    constructor(app: express.Express, logger: winston.Logger) {
        this.app = app;
        this.logger = logger;
        this.prisma = new PrismaClient();
        this.setupRoutes();
        this.init();
    }

    async init() {
        // Prepare playlists
        const videos = await this.prisma.videos.findMany({
            orderBy: {
                sortOrder: 'asc',
            },
        })
        for (const media of videos) {
            // Store playlist data
            if (Object.hasOwnProperty.call(this.playLists, media.playListId)) {
                continue
            }
            this.playLists[media.playListId] = {
                mediaId: media.id,
                duration: media.duration,
                filePath: media.filePath,
                isPlaying: true,
                time: 0,
                volume: 1,
            }
        }
    }

    setupRoutes() {
        this.app.use(fileupload());
        this.app.use('/media/uploads', express.static('uploads'));
        this.app.post('/media/add-user', this.validateSystem, this.onAddUser)
        this.app.post('/media/remove-user', this.validateSystem, this.onRemoveUser)
        this.app.post('/media/upload', this.validateUser, this.onUploadMedia)
        this.app.delete('/media/:id', this.validateUser, this.onDeleteMedia)
        this.app.get('/media/:playListId', this.onGetMediaList)
    }

    onAddUser(req: express.Request, res: express.Response) {
        const connectionKey = nanoid();
        const connectingUser = {
            userId: req.body.userId,
            connectionKey: connectionKey,
            token: req.body.userId + "|" + connectionKey,
        } as IClientData
        this.connectingUsers[req.body.userId] = connectingUser
        // Send response back
        res.status(200).send(connectingUser)
    }

    onRemoveUser(req: express.Request, res: express.Response) {
        delete this.connectingUsers[req.body.userId]
        res.status(200).send()
    }

    async onUploadMedia(req: express.Request, res: express.Response) {
        try {
            if (!req.files) {
                // No files
                res.sendStatus(404)
            } else {
                // Get and move video file to upload path
                const id = nanoid()
                const playListId: string = req.body.playListId
                const file: fileupload.UploadedFile = req.files.file as fileupload.UploadedFile
                const fileName = file.name
                const savePath = '.media/uploads/' + id + '_' + fileName
                const fullSavePath = process.cwd() + '/media/uploads/' + id + '_' + fileName
                await file.mv(fullSavePath)

                const duration = await getVideoDurationInSeconds(
                    fullSavePath
                )

                const lastVideo = await this.prisma.videos.findFirst({
                    where: {
                        playListId: playListId,
                    },
                    orderBy: {
                        sortOrder: 'desc',
                    },
                })

                // Store video to database
                const media = await this.prisma.videos.create({
                    data: {
                        id: id,
                        playListId: playListId,
                        filePath: savePath,
                        duration: duration,
                        sortOrder: lastVideo ? lastVideo.sortOrder + 1 : 1,
                    },
                })

                // Create new playlist if it not existed
                if (!Object.hasOwnProperty.call(this.playLists, playListId)) {
                    this.playLists[playListId] = {
                        mediaId: media.id,
                        duration: media.duration,
                        filePath: media.filePath,
                        isPlaying: true,
                        time: 0,
                    } as IMediaData;
                }

                if (!lastVideo) {
                    // This is first video
                    if (!Object.hasOwnProperty.call(this.playListSubscribers, playListId)) {
                        this.playListSubscribers[playListId] = []
                    }
                    const currentPlayListSubscribers = this.playListSubscribers[playListId]
                    for (const currentPlayListSubscriber of currentPlayListSubscribers) {
                        currentPlayListSubscriber.send('resp', {
                            playListId: playListId,
                            mediaId: media.id,
                            isPlaying: true,
                            filePath: savePath,
                            time: 0,
                            duration: duration,
                        } as IMediaResp)
                    }
                }
                res.status(200).send()
            }
        } catch (err) {
            console.error(err)
            res.status(500).send(err)
        }
    }

    onDeleteMedia(req: express.Request, res: express.Response) {
        this.deletingMediaIds.push(req.params.id)
        res.status(200).send()
    }

    async onGetMediaList(req: express.Request, res: express.Response) {
        const videos = await this.prisma.videos.findMany({
            where: {
                playListId: req.params.playListId,
            },
            orderBy: {
                sortOrder: 'asc',
            },
        })
        // Don't include deleting media
        for (let index = videos.length - 1; index >= 0; --index) {
            const video = videos[index]
            if (this.deletingMediaIds.indexOf(video.id) >= 0) {
                videos.splice(index, 1)
            }
        }
        res.status(200).send(videos)
    }

    validateSystem(req: express.Request, res: express.Response, next: express.NextFunction) {
        // This must be able to connect by game-server only, don't allow client to connect
        // Validate connection by secret key which will be included in header -> authorization
        const bearerHeader = req.headers['authorization']
        if (!bearerHeader) {
            res.sendStatus(400)
            return
        }
        // Substring `bearer `, length is 7
        const bearerToken = bearerHeader.substring(7)
        const secretKeys = JSON.parse(process.env.SECRET_KEYS || "[]")
        if (secretKeys.indexOf(bearerToken) < 0) {
            res.sendStatus(400)
            return
        }
        next()
    }

    validateUser(req: express.Request, res: express.Response, next: express.NextFunction) {
        const bearerHeader = req.headers['authorization']
        if (!bearerHeader) {
            res.sendStatus(400)
            return
        }

        // Substring `bearer `, length is 7
        const token = bearerHeader.substring(7)
        const splitingData = token.split("|")
        if (splitingData.length < 2) {
            res.sendStatus(400)
            return
        }

        const userId = splitingData[0]
        const connectionKey = splitingData[1]
        if (!userId) {
            res.sendStatus(400)
            return
        }

        if (!Object.prototype.hasOwnProperty.call(this.connectingUsers, userId)) {
            res.sendStatus(400)
            return
        }

        const connectingUser = this.connectingUsers[userId]
        if (connectionKey != connectingUser.connectionKey) {
            res.sendStatus(400)
            return
        }
        next()
    }

    sendResp(client: Client, playListId: any, currentPlayList: any) {
        client.send('resp', {
            playListId: playListId,
            mediaId: currentPlayList.mediaId,
            isPlaying: currentPlayList.isPlaying,
            filePath: currentPlayList.filePath,
            time: currentPlayList.time,
            volume: currentPlayList.volume,
            duration: currentPlayList.duration,
        } as IMediaResp)
    }

    public onCreateRoom(room: MediaRoom) {
        room.onMessage("sub", this.onSub)
        room.onMessage("play", this.onPlay)
        room.onMessage("pause", this.onPause)
        room.onMessage("stop", this.onStop)
        room.onMessage("seek", this.onSeek)
        room.onMessage("volume", this.onVolume)
        room.onMessage("switch", this.onSwitch)
        const self = this
        room.setSimulationInterval((deltaTime: number) => this.update(deltaTime, self.prisma, self.playLists, self.playListSubscribers, self.deletingMediaIds), 1000);
    }

    onSub(client: Client, playListId: string) {
        this.logger.info(`[media] ${client.id} requested to sub ${playListId}`)
        if (!Object.hasOwnProperty.call(this.playListSubscribers, playListId)) {
            this.playListSubscribers[playListId] = []
        }
        const currentPlayListSubscribers = this.playListSubscribers[playListId]
        if (currentPlayListSubscribers.indexOf(client) < 0) {
            currentPlayListSubscribers.push(client)
            this.logger.info(`[media] ${client.id} sub ${playListId}`)
        }
        // Find the playlist, if found then `resp`
        if (!Object.hasOwnProperty.call(this.playLists, playListId)) {
            return
        }
        const currentPlayList = this.playLists[playListId]
        // Response current media to the client
        this.sendResp(client, playListId, currentPlayList)
    }

    onPlay(client: Client, playListId: string) {
        const userId = client.userData.userId
        if (!userId) {
            return
        }
        this.logger.info(`[media] ${client.id} requested to play ${playListId} by user: ${userId}`)
        if (!Object.hasOwnProperty.call(this.playLists, playListId)) {
            return
        }
        const currentPlayList = this.playLists[playListId]
        if (!Object.hasOwnProperty.call(this.playListSubscribers, playListId)) {
            this.playListSubscribers[playListId] = []
        }
        const currentPlayListSubscribers = this.playListSubscribers[playListId]
        currentPlayList.isPlaying = true
        this.playLists[playListId] = currentPlayList
        for (let i = 0; i < currentPlayListSubscribers.length; ++i) {
            this.sendResp(currentPlayListSubscribers[i], playListId, currentPlayList)
        }
        this.logger.info(`[media] ${client.id} play ${playListId}`)
    }

    onPause(client: Client, playListId: string) {
        const userId = client.userData.userId
        if (!userId) {
            return
        }
        this.logger.info(`[media] ${client.id} requested to pause ${playListId} by user: ${userId}`)
        if (!Object.hasOwnProperty.call(this.playLists, playListId)) {
            return
        }
        const currentPlayList = this.playLists[playListId]
        if (!Object.hasOwnProperty.call(this.playListSubscribers, playListId)) {
            this.playListSubscribers[playListId] = []
        }
        const currentPlayListSubscribers = this.playListSubscribers[playListId]
        currentPlayList.isPlaying = false
        this.playLists[playListId] = currentPlayList
        for (let i = 0; i < currentPlayListSubscribers.length; ++i) {
            this.sendResp(currentPlayListSubscribers[i], playListId, currentPlayList)
        }
        this.logger.info(`[media] ${client.id} pause ${playListId}`)
    }

    onStop(client: Client, playListId: string) {
        const userId = client.userData.userId
        if (!userId) {
            return
        }
        this.logger.info(`[media] ${client.id} requested to stop ${playListId} by user: ${userId}`)
        if (!Object.hasOwnProperty.call(this.playLists, playListId)) {
            return
        }
        const currentPlayList = this.playLists[playListId]
        if (!Object.hasOwnProperty.call(this.playListSubscribers, playListId)) {
            this.playListSubscribers[playListId] = []
        }
        const currentPlayListSubscribers = this.playListSubscribers[playListId]
        currentPlayList.isPlaying = false
        currentPlayList.time = 0
        this.playLists[playListId] = currentPlayList
        for (let i = 0; i < currentPlayListSubscribers.length; ++i) {
            this.sendResp(currentPlayListSubscribers[i], playListId, currentPlayList)
        }
        this.logger.info(`[media] ${client.id} stop ${playListId}`)
    }

    onSeek(client: Client, msg: any) {
        const userId = client.userData.userId
        if (!userId) {
            return
        }
        const playListId = msg.playListId
        this.logger.info(`[media] ${client.id} requested to seek ${playListId} by user: ${userId}`)
        if (!Object.hasOwnProperty.call(this.playLists, playListId)) {
            return
        }
        const currentPlayList = this.playLists[playListId]
        if (!Object.hasOwnProperty.call(this.playListSubscribers, playListId)) {
            this.playListSubscribers[playListId] = []
        }
        const currentPlayListSubscribers = this.playListSubscribers[playListId]
        currentPlayList.time = msg.time
        this.playLists[playListId] = currentPlayList
        for (let i = 0; i < currentPlayListSubscribers.length; ++i) {
            this.sendResp(currentPlayListSubscribers[i], playListId, currentPlayList)
        }
        this.logger.info(`[media] ${client.id} seek ${playListId}`)
    }

    onVolume(client: Client, data: any) {
        const userId = client.userData.userId
        if (!userId) {
            return
        }
        const playListId = data.playListId
        this.logger.info(`[media] ${client.id} requested to volume ${playListId} by user: ${userId}`)
        if (!Object.hasOwnProperty.call(this.playLists, playListId)) {
            return
        }
        const currentPlayList = this.playLists[playListId]
        if (!Object.hasOwnProperty.call(this.playListSubscribers, playListId)) {
            this.playListSubscribers[playListId] = []
        }
        const currentPlayListSubscribers = this.playListSubscribers[playListId]
        currentPlayList.volume = data.volume
        this.playLists[playListId] = currentPlayList
        for (let i = 0; i < currentPlayListSubscribers.length; ++i) {
            this.sendResp(currentPlayListSubscribers[i], playListId, currentPlayList)
        }
        this.logger.info(`[media] ${client.id} volume ${playListId}`)
    }

    async onSwitch(client: Client, data: any) {
        const userId = client.userData.userId
        if (!userId) {
            return
        }
        const playListId = data.playListId
        this.logger.info(`[media] ${client.id} requested to switch ${playListId} by user: ${userId}`)
        if (!Object.hasOwnProperty.call(this.playLists, playListId)) {
            return
        }
        const currentPlayList = this.playLists[playListId]
        if (!Object.hasOwnProperty.call(this.playListSubscribers, playListId)) {
            this.playListSubscribers[playListId] = []
        }
        const mediaId = data.mediaId
        const media = await this.prisma.videos.findFirst({
            where: {
                id: mediaId,
                playListId: playListId,
            },
        })
        // Can't find the media
        if (!media) {
            return
        }
        // Switch media
        currentPlayList.mediaId = mediaId
        currentPlayList.isPlaying = true
        currentPlayList.filePath = media.filePath
        currentPlayList.time = 0
        currentPlayList.duration = media.duration
        const currentPlayListSubscribers = this.playListSubscribers[playListId]
        this.playLists[playListId] = currentPlayList
        for (let i = 0; i < currentPlayListSubscribers.length; ++i) {
            this.sendResp(currentPlayListSubscribers[i], playListId, currentPlayList)
        }
        this.logger.info(`[media] ${client.id} switch ${playListId}`)
    }

    async update(
        deltaTime: number,
        prisma: PrismaClient,
        playLists: { [id: string]: IMediaData },
        playListSubscribers: { [id: string]: Client[] },
        deletingMediaIds: string[]) {
        const deletingPlayLists: string[] = []
        for (const playListId in playLists) {
            if (!Object.hasOwnProperty.call(playLists, playListId)) {
                continue
            }
            const playList = playLists[playListId]
            if (!playList.isPlaying) {
                continue
            }
            const indexOfDeletingMedia = deletingMediaIds.indexOf(playList.mediaId)
            playList.time += deltaTime * 0.001
            if (indexOfDeletingMedia >= 0 || playList.time >= playList.duration) {
                // Load new meida to play
                const medias = await prisma.videos.findMany({
                    where: {
                        playListId: playListId,
                    },
                    orderBy: {
                        sortOrder: 'asc',
                    },
                })
                // Find index of new media
                let indexOfNewMedia = -1
                for (let index = 0; index < medias.length; ++index) {
                    const media = medias[index]
                    if (media.id != playList.mediaId) {
                        continue
                    }
                    indexOfNewMedia = index + 1
                    if (indexOfNewMedia >= medias.length) {
                        indexOfNewMedia = 0
                    }
                    break
                }
                // Delete the media after change to new video
                if (indexOfDeletingMedia >= 0) {
                    deletingMediaIds.splice(indexOfDeletingMedia, 1)
                    if (medias.length == 1) {
                        indexOfNewMedia = -1
                    }
                    await prisma.videos.delete({
                        where: {
                            id: playList.mediaId,
                        },
                    })
                }
                // Setup new media data to playlist
                if (indexOfNewMedia >= 0) {
                    const media = medias[indexOfNewMedia]
                    playList.mediaId = media.id
                    playList.duration = media.duration
                    playList.filePath = media.filePath
                    playList.isPlaying = true
                    playList.time = 0
                    if (Object.hasOwnProperty.call(playListSubscribers, playListId)) {
                        for (const subscriber of playListSubscribers[playListId]) {
                            subscriber.send('resp', {
                                playListId: playListId,
                                mediaId: playList.mediaId,
                                duration: playList.duration,
                                filePath: playList.filePath,
                                isPlaying: playList.isPlaying,
                                time: playList.time,
                                volume: playList.volume,
                            } as IMediaResp)
                        }
                    }
                } else {
                    deletingPlayLists.push(playListId)
                    if (Object.hasOwnProperty.call(playListSubscribers, playListId)) {
                        for (const subscriber of playListSubscribers[playListId]) {
                            subscriber.send('resp', {
                                playListId: playListId,
                                mediaId: '',
                                duration: 0,
                                filePath: '',
                                isPlaying: false,
                                time: 0,
                                volume: 0,
                            } as IMediaResp)
                        }
                    }
                }
            }
        }
        // Delete empty playlists
        for (const playListId of deletingPlayLists) {
            delete playLists[playListId]
        }
    }

    public async onAuth(client: Client, options: any) {
        const token = options.token
        if (!token) {
            return
        }

        const splitingData = token.split("|")
        if (splitingData.length < 2) {
            return
        }

        const userId = splitingData[0]
        const connectionKey = splitingData[1]
        if (!userId) {
            return
        }

        if (!Object.prototype.hasOwnProperty.call(this.connectingUsers, userId)) {
            return
        }

        const connectingUser = this.connectingUsers[userId]
        if (connectionKey != connectingUser.connectionKey) {
            return
        }

        // Disconnect older socket
        if (Object.prototype.hasOwnProperty.call(this.connections, userId)) {
            this.connections[userId].leave()
            this.logger.info(`[media] Disconnect [${this.connections[userId].id}] because it is going to connect by newer client with the same user ID`)
        }

        // Set user data after connected
        client.userData = connectingUser

        // Set socket client to the collections
        this.connections[userId] = client
    }

    public onDisconnect(client: Client) {
        for (const key in this.playListSubscribers) {
            if (!Object.hasOwnProperty.call(this.playListSubscribers, key)) {
                continue;
            }
            const currentPlayListSubscribers = this.playListSubscribers[key]
            const index = currentPlayListSubscribers.indexOf(client);
            if (index >= 0) {
                currentPlayListSubscribers.splice(index, 1);
            }
        }
    }
}

interface IClientData {
    userId: string;
    connectionKey: string;
    token: string;
}

interface IMediaData {
    mediaId: string,
    duration: number,
    filePath: string,
    isPlaying: boolean,
    time: number,
    volume: number,
}

interface IMediaResp {
    playListId: string;
    mediaId: string;
    duration: number;
    filePath: string;
    isPlaying: boolean;
    time: number;
    volume: number;
}