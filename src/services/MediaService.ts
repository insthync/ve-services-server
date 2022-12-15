import winston from "winston";
import express from "express";
import fileupload from 'express-fileupload'
import { PrismaClient } from '@prisma/client'
import { nanoid } from "nanoid";
import { getVideoDurationInSeconds } from 'get-video-duration'
import { Client } from "colyseus";
import { MediaRoom } from "../rooms/MediaRoom";
import { getLogger } from "..";

export class MediaService {
    private app: express.Express;
    private logger: winston.Logger;
    private prisma: PrismaClient;
    private playLists: { [id: string]: any } = {}
    private playListSubscribers: { [id: string]: Client[] } = {}
    private deletingMediaIds: string[] = []
    private adminUserTokens: string[] = []

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

        app.use(fileupload());
        app.use('/uploads', express.static('uploads'));

        app.post('/add-user', this.validateSystem, async (req, res) => {
            const userToken = req.body.userToken
            if (this.adminUserTokens.indexOf(userToken) < 0) {
                this.adminUserTokens.push(userToken)
            }
            res.sendStatus(200)
        })

        app.post('/remove-user', this.validateSystem, async (req, res) => {
            const userToken = req.body.userToken
            const index = this.adminUserTokens.indexOf(userToken)
            if (index >= 0) {
                this.adminUserTokens.splice(index, 1)
            }
            res.sendStatus(200)
        })

        app.post('/upload', this.validateUser, async (req: express.Request, res: express.Response) => {
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
                    const savePath = './uploads/' + id + '_' + fileName
                    const fullSavePath = process.cwd() + '/uploads/' + id + '_' + fileName
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
                            mediaDuration: media.duration,
                            filePath: media.filePath,
                            isPlaying: true,
                            time: 0,
                        }
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
                            })
                        }
                    }

                    res.status(200).send()
                }
            } catch (err) {
                console.error(err)
                res.status(500).send(err)
            }
        })

        app.delete('/:id', this.validateUser, async (req, res) => {
            this.deletingMediaIds.push(req.params.id)
            res.status(200).send()
        })

        app.get('/:playListId', async (req, res) => {
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
        })
    }

    validateSystem(req: express.Request, res: express.Response, next: express.NextFunction) {
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
        const bearerToken = bearerHeader.substring(7)
        if (this.adminUserTokens.indexOf(bearerToken) < 0) {
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
        })
    }

    public onCreateRoom(room: MediaRoom) {
        const logger = this.logger;
        room.onMessage('sub', (socket, msg) => {
            logger.info('[media] ' + socket.id + ' requested to sub ' + msg.playListId)
            const playListId = msg.playListId
            if (!Object.hasOwnProperty.call(this.playListSubscribers, playListId)) {
                this.playListSubscribers[playListId] = []
            }
            const currentPlayListSubscribers = this.playListSubscribers[playListId]
            if (currentPlayListSubscribers.indexOf(socket) < 0) {
                currentPlayListSubscribers.push(socket)
                logger.info('[media] ' + socket.id + ' sub ' + playListId)
            }
            // Find the playlist, if found then `resp`
            if (!Object.hasOwnProperty.call(this.playLists, playListId)) {
                return
            }
            const currentPlayList = this.playLists[playListId]
            // Response current media to the client
            this.sendResp(socket, playListId, currentPlayList)
        })

        room.onMessage('play', (socket, msg) => {
            logger.info('[media] ' + socket.id + ' requested to play ' + msg.playListId + ' by user: ' + msg.userToken)
            const userToken = msg.userToken
            if (this.adminUserTokens.indexOf(userToken) < 0) {
                return
            }
            const playListId = msg.playListId
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
            currentPlayListSubscribers.forEach(element => {
                this.sendResp(element, playListId, currentPlayList)
            })
            logger.info('[media] ' + socket.id + ' play ' + playListId)
        })

        room.onMessage('pause', (socket, msg) => {
            logger.info('[media] ' + socket.id + ' requested to pause ' + msg.playListId + ' by user: ' + msg.userToken)
            const userToken = msg.userToken
            if (this.adminUserTokens.indexOf(userToken) < 0) {
                return
            }
            const playListId = msg.playListId
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
            currentPlayListSubscribers.forEach(element => {
                this.sendResp(element, playListId, currentPlayList)
            })
            logger.info('[media] ' + socket.id + ' pause ' + playListId)
        })

        room.onMessage('stop', (socket, msg) => {
            logger.info('[media] ' + socket.id + ' requested to stop ' + msg.playListId + ' by user: ' + msg.userToken)
            const userToken = msg.userToken
            if (this.adminUserTokens.indexOf(userToken) < 0) {
                return
            }
            const playListId = msg.playListId
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
            currentPlayListSubscribers.forEach(element => {
                this.sendResp(element, playListId, currentPlayList)
            })
            logger.info('[media] ' + socket.id + ' stop ' + playListId)
        })

        room.onMessage('seek', (socket, msg) => {
            logger.info('[media] ' + socket.id + ' requested to seek ' + msg.playListId + ' by user: ' + msg.userToken)
            const userToken = msg.userToken
            if (this.adminUserTokens.indexOf(userToken) < 0) {
                return
            }
            const playListId = msg.playListId
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
            currentPlayListSubscribers.forEach(element => {
                this.sendResp(element, playListId, currentPlayList)
            })
            logger.info('[media] ' + socket.id + ' seek ' + playListId)
        })

        room.onMessage('volume', (socket, msg) => {
            logger.info('[media] ' + socket.id + ' requested to volume ' + msg.playListId + ' by user: ' + msg.userToken)
            const userToken = msg.userToken
            if (this.adminUserTokens.indexOf(userToken) < 0) {
                return
            }
            const playListId = msg.playListId
            if (!Object.hasOwnProperty.call(this.playLists, playListId)) {
                return
            }
            const currentPlayList = this.playLists[playListId]
            if (!Object.hasOwnProperty.call(this.playListSubscribers, playListId)) {
                this.playListSubscribers[playListId] = []
            }
            const currentPlayListSubscribers = this.playListSubscribers[playListId]
            currentPlayList.volume = msg.volume
            this.playLists[playListId] = currentPlayList
            currentPlayListSubscribers.forEach(element => {
                this.sendResp(element, playListId, currentPlayList)
            })
            logger.info('[media] ' + socket.id + ' volume ' + playListId)
        })

        room.onMessage('switch', async (socket, msg) => {
            logger.info('[media] ' + socket.id + ' requested to switch ' + msg.playListId + ' by user: ' + msg.userToken)
            const userToken = msg.userToken
            if (this.adminUserTokens.indexOf(userToken) < 0) {
                return
            }
            const playListId = msg.playListId
            if (!Object.hasOwnProperty.call(this.playLists, playListId)) {
                return
            }
            const currentPlayList = this.playLists[playListId]
            if (!Object.hasOwnProperty.call(this.playListSubscribers, playListId)) {
                this.playListSubscribers[playListId] = []
            }
            const mediaId = msg.mediaId
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
            currentPlayListSubscribers.forEach(element => {
                this.sendResp(element, playListId, currentPlayList)
            })
            logger.info('[media] ' + socket.id + ' switch ' + playListId)
        })
    }

    public onDisconnect(client: Client) {
        for (const key in this.playListSubscribers) {
            if (Object.hasOwnProperty.call(this.playListSubscribers, key)) {
                const currentPlayListSubscribers = this.playListSubscribers[key]
                const index = currentPlayListSubscribers.indexOf(client);
                if (index >= 0) {
                    currentPlayListSubscribers.splice(index, 1);
                }
            }
        }
    }
}