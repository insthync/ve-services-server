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
        const app = this.app;
        const prisma = this.prisma;
        const playLists = this.playLists;
        const playListSubscribers = this.playListSubscribers;
        const deletingMediaIds = this.deletingMediaIds;
        const connectingUsers = this.connectingUsers;
        const validateSystem = this.validateSystem;
        const validateUser = this.validateUser;

        app.use(fileupload());
        app.use('/media/uploads', express.static('uploads'));

        app.post('/media/add-user', validateSystem, async (req, res) => {
            const connectionKey = nanoid();
            const connectingUser = {
                userId: req.body.userId,
                connectionKey: connectionKey,
                token: req.body.userId + "|" + connectionKey,
            } as IClientData
            connectingUsers[req.body.userId] = connectingUser
            // Send response back
            res.status(200).send(connectingUser)
        })

        app.post('/media/remove-user', validateSystem, async (req, res) => {
            delete connectingUsers[req.body.userId]
            res.status(200).send()
        })

        app.post('/media/upload', validateUser, async (req: express.Request, res: express.Response) => {
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

                    const lastVideo = await prisma.videos.findFirst({
                        where: {
                            playListId: playListId,
                        },
                        orderBy: {
                            sortOrder: 'desc',
                        },
                    })

                    // Store video to database
                    const media = await prisma.videos.create({
                        data: {
                            id: id,
                            playListId: playListId,
                            filePath: savePath,
                            duration: duration,
                            sortOrder: lastVideo ? lastVideo.sortOrder + 1 : 1,
                        },
                    })

                    // Create new playlist if it not existed
                    if (!Object.hasOwnProperty.call(playLists, playListId)) {
                        playLists[playListId] = {
                            mediaId: media.id,
                            duration: media.duration,
                            filePath: media.filePath,
                            isPlaying: true,
                            time: 0,
                        } as IMediaData;
                    }

                    if (!lastVideo) {
                        // This is first video
                        if (!Object.hasOwnProperty.call(playListSubscribers, playListId)) {
                            playListSubscribers[playListId] = []
                        }
                        const currentPlayListSubscribers = playListSubscribers[playListId]
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
        })

        app.delete('/media/:id', validateUser, async (req, res) => {
            deletingMediaIds.push(req.params.id)
            res.status(200).send()
        })

        app.get('/media/:playListId', async (req, res) => {
            const videos = await prisma.videos.findMany({
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
                if (deletingMediaIds.indexOf(video.id) >= 0) {
                    videos.splice(index, 1)
                }
            }
            res.status(200).send(videos)
        })
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
        const logger = this.logger;
        const prisma = this.prisma;
        const playLists = this.playLists;
        const playListSubscribers = this.playListSubscribers;
        const deletingMediaIds = this.deletingMediaIds;
        const adminUserIds = this.connectingUsers;
        const sendResp = this.sendResp;

        room.onMessage("sub", (client, playListId) => {
            logger.info(`[media] ${client.id} requested to sub ${playListId}`)
            if (!Object.hasOwnProperty.call(playListSubscribers, playListId)) {
                playListSubscribers[playListId] = []
            }
            const currentPlayListSubscribers = playListSubscribers[playListId]
            if (currentPlayListSubscribers.indexOf(client) < 0) {
                currentPlayListSubscribers.push(client)
                logger.info(`[media] ${client.id} sub ${playListId}`)
            }
            // Find the playlist, if found then `resp`
            if (!Object.hasOwnProperty.call(playLists, playListId)) {
                return
            }
            const currentPlayList = playLists[playListId]
            // Response current media to the client
            sendResp(client, playListId, currentPlayList)
        })

        room.onMessage("play", (client, playListId) => {
            const userId = client.userData.userId
            if (!userId) {
                return
            }
            logger.info(`[media] ${client.id} requested to play ${playListId} by user: ${userId}`)
            if (!Object.hasOwnProperty.call(playLists, playListId)) {
                return
            }
            const currentPlayList = playLists[playListId]
            if (!Object.hasOwnProperty.call(playListSubscribers, playListId)) {
                playListSubscribers[playListId] = []
            }
            const currentPlayListSubscribers = playListSubscribers[playListId]
            currentPlayList.isPlaying = true
            playLists[playListId] = currentPlayList
            currentPlayListSubscribers.forEach(element => {
                sendResp(element, playListId, currentPlayList)
            })
            logger.info(`[media] ${client.id} play ${playListId}`)
        })

        room.onMessage("pause", (client, playListId) => {
            const userId = client.userData.userId
            if (!userId) {
                return
            }
            logger.info(`[media] ${client.id} requested to pause ${playListId} by user: ${userId}`)
            if (!Object.hasOwnProperty.call(playLists, playListId)) {
                return
            }
            const currentPlayList = playLists[playListId]
            if (!Object.hasOwnProperty.call(playListSubscribers, playListId)) {
                playListSubscribers[playListId] = []
            }
            const currentPlayListSubscribers = playListSubscribers[playListId]
            currentPlayList.isPlaying = false
            playLists[playListId] = currentPlayList
            currentPlayListSubscribers.forEach(element => {
                sendResp(element, playListId, currentPlayList)
            })
            logger.info(`[media] ${client.id} pause ${playListId}`)
        })

        room.onMessage("stop", (client, playListId) => {
            const userId = client.userData.userId
            if (!userId) {
                return
            }
            logger.info(`[media] ${client.id} requested to stop ${playListId} by user: ${userId}`)
            if (!Object.hasOwnProperty.call(playLists, playListId)) {
                return
            }
            const currentPlayList = playLists[playListId]
            if (!Object.hasOwnProperty.call(playListSubscribers, playListId)) {
                playListSubscribers[playListId] = []
            }
            const currentPlayListSubscribers = playListSubscribers[playListId]
            currentPlayList.isPlaying = false
            currentPlayList.time = 0
            playLists[playListId] = currentPlayList
            currentPlayListSubscribers.forEach(element => {
                sendResp(element, playListId, currentPlayList)
            })
            logger.info(`[media] ${client.id} stop ${playListId}`)
        })

        room.onMessage("seek", (client, msg) => {
            const userId = client.userData.userId
            if (!userId) {
                return
            }
            const playListId = msg.playListId
            logger.info(`[media] ${client.id} requested to seek ${playListId} by user: ${userId}`)
            if (!Object.hasOwnProperty.call(playLists, playListId)) {
                return
            }
            const currentPlayList = playLists[playListId]
            if (!Object.hasOwnProperty.call(playListSubscribers, playListId)) {
                playListSubscribers[playListId] = []
            }
            const currentPlayListSubscribers = playListSubscribers[playListId]
            currentPlayList.time = msg.time
            playLists[playListId] = currentPlayList
            currentPlayListSubscribers.forEach(element => {
                sendResp(element, playListId, currentPlayList)
            })
            logger.info(`[media] ${client.id} seek ${playListId}`)
        })

        room.onMessage("volume", (client, msg) => {
            const userId = client.userData.userId
            if (!userId) {
                return
            }
            const playListId = msg.playListId
            logger.info(`[media] ${client.id} requested to volume ${playListId} by user: ${userId}`)
            if (!Object.hasOwnProperty.call(playLists, playListId)) {
                return
            }
            const currentPlayList = playLists[playListId]
            if (!Object.hasOwnProperty.call(playListSubscribers, playListId)) {
                playListSubscribers[playListId] = []
            }
            const currentPlayListSubscribers = playListSubscribers[playListId]
            currentPlayList.volume = msg.volume
            playLists[playListId] = currentPlayList
            currentPlayListSubscribers.forEach(element => {
                sendResp(element, playListId, currentPlayList)
            })
            logger.info(`[media] ${client.id} volume ${playListId}`)
        })

        room.onMessage("switch", async (client, msg) => {
            const userId = client.userData.userId
            if (!userId) {
                return
            }
            const playListId = msg.playListId
            logger.info(`[media] ${client.id} requested to switch ${playListId} by user: ${userId}`)
            if (!Object.hasOwnProperty.call(playLists, playListId)) {
                return
            }
            const currentPlayList = playLists[playListId]
            if (!Object.hasOwnProperty.call(playListSubscribers, playListId)) {
                playListSubscribers[playListId] = []
            }
            const mediaId = msg.mediaId
            const media = await prisma.videos.findFirst({
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
            const currentPlayListSubscribers = playListSubscribers[playListId]
            playLists[playListId] = currentPlayList
            currentPlayListSubscribers.forEach(element => {
                sendResp(element, playListId, currentPlayList)
            })
            logger.info(`[media] ${client.id} switch ${playListId}`)
        })

        const update = this.update;
        room.setSimulationInterval((deltaTime: number) => update(deltaTime, prisma, playLists, playListSubscribers, deletingMediaIds), 1000);
    }

    async update(
        deltaTime: number,
        prisma: PrismaClient,
        playLists: { [id: string]: IMediaData },
        playListSubscribers: { [id: string]: Client[] },
        deletingMediaIds: string[])
    {
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
        const logger = this.logger;
        const connectingUsers = this.connectingUsers;
        const connections = this.connections;

        const token = options.token
        const splitingData = token.split("|")
        if (splitingData.length < 2) {
            client.leave()
            logger.info(`[chat] Not allow [${client.id}] to connect because the token is invalid`)
            return
        }

        const userId = splitingData[0]
        const connectionKey = splitingData[1]
        if (!userId) {
            client.leave()
            logger.info(`[chat] Not allow [${client.id}] to connect because it has invalid user ID`)
            return
        }
        
        if (!Object.prototype.hasOwnProperty.call(connectingUsers, userId)) {
            client.leave()
            logger.info(`[chat] Not allow [${client.id}] to connect because it has invalid user ID`)
            return
        }

        const connectingUser = connectingUsers[userId]
        if (connectionKey != connectingUser.connectionKey) {
            client.leave()
            logger.info(`[chat] Not allow [${client.id}] to connect because it has invalid connection key`)
            return
        }

        // Disconnect older socket
        if (Object.prototype.hasOwnProperty.call(connections, userId)) {
            connections[userId].leave()
            logger.info(`[chat] Disconnect [${connections[userId].id}] because it is going to connect by newer client with the same user ID`)
        }

        // Set user data after connected
        client.userData = connectingUser

        // Set socket client to the collections
        connections[userId] = client
    }

    public onDisconnect(client: Client) {
        const playListSubscribers = this.playListSubscribers;
        for (const key in playListSubscribers) {
            if (!Object.hasOwnProperty.call(playListSubscribers, key)) {
                continue;
            }
            const currentPlayListSubscribers = playListSubscribers[key]
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