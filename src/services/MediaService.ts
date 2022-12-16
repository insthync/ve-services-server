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
        const prisma = this.prisma;
        const playLists = this.playLists;
        const playListSubscribers = this.playListSubscribers;
        const deletingMediaIds = this.deletingMediaIds;
        const adminUserTokens = this.adminUserTokens;
        const validateSystem = this.validateSystem;
        const validateUser = this.validateUser;

        app.use(fileupload());
        app.use('/media/uploads', express.static('uploads'));

        app.post('/media/add-user', validateSystem, async (req, res) => {
            const userToken = req.body.userToken
            if (adminUserTokens.indexOf(userToken) < 0) {
                adminUserTokens.push(userToken)
            }
            res.sendStatus(200)
        })

        app.post('/media/remove-user', validateSystem, async (req, res) => {
            const userToken = req.body.userToken
            const index = adminUserTokens.indexOf(userToken)
            if (index >= 0) {
                adminUserTokens.splice(index, 1)
            }
            res.sendStatus(200)
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
                    const savePath = './uploads/' + id + '_' + fileName
                    const fullSavePath = process.cwd() + '/uploads/' + id + '_' + fileName
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
                            mediaDuration: media.duration,
                            filePath: media.filePath,
                            isPlaying: true,
                            time: 0,
                        }
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
        const prisma = this.prisma;
        const playLists = this.playLists;
        const playListSubscribers = this.playListSubscribers;
        const adminUserTokens = this.adminUserTokens;
        const sendResp = this.sendResp;

        room.onMessage('sub', (client, msg) => {
            logger.info('[media] ' + client.id + ' requested to sub ' + msg.playListId)
            const playListId = msg.playListId
            if (!Object.hasOwnProperty.call(playListSubscribers, playListId)) {
                playListSubscribers[playListId] = []
            }
            const currentPlayListSubscribers = playListSubscribers[playListId]
            if (currentPlayListSubscribers.indexOf(client) < 0) {
                currentPlayListSubscribers.push(client)
                logger.info('[media] ' + client.id + ' sub ' + playListId)
            }
            // Find the playlist, if found then `resp`
            if (!Object.hasOwnProperty.call(playLists, playListId)) {
                return
            }
            const currentPlayList = playLists[playListId]
            // Response current media to the client
            sendResp(client, playListId, currentPlayList)
        })

        room.onMessage('play', (client, msg) => {
            logger.info('[media] ' + client.id + ' requested to play ' + msg.playListId + ' by user: ' + msg.userToken)
            const userToken = msg.userToken
            if (adminUserTokens.indexOf(userToken) < 0) {
                return
            }
            const playListId = msg.playListId
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
            logger.info('[media] ' + client.id + ' play ' + playListId)
        })

        room.onMessage('pause', (client, msg) => {
            logger.info('[media] ' + client.id + ' requested to pause ' + msg.playListId + ' by user: ' + msg.userToken)
            const userToken = msg.userToken
            if (adminUserTokens.indexOf(userToken) < 0) {
                return
            }
            const playListId = msg.playListId
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
            logger.info('[media] ' + client.id + ' pause ' + playListId)
        })

        room.onMessage('stop', (client, msg) => {
            logger.info('[media] ' + client.id + ' requested to stop ' + msg.playListId + ' by user: ' + msg.userToken)
            const userToken = msg.userToken
            if (adminUserTokens.indexOf(userToken) < 0) {
                return
            }
            const playListId = msg.playListId
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
            logger.info('[media] ' + client.id + ' stop ' + playListId)
        })

        room.onMessage('seek', (client, msg) => {
            logger.info('[media] ' + client.id + ' requested to seek ' + msg.playListId + ' by user: ' + msg.userToken)
            const userToken = msg.userToken
            if (adminUserTokens.indexOf(userToken) < 0) {
                return
            }
            const playListId = msg.playListId
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
            logger.info('[media] ' + client.id + ' seek ' + playListId)
        })

        room.onMessage('volume', (client, msg) => {
            logger.info('[media] ' + client.id + ' requested to volume ' + msg.playListId + ' by user: ' + msg.userToken)
            const userToken = msg.userToken
            if (adminUserTokens.indexOf(userToken) < 0) {
                return
            }
            const playListId = msg.playListId
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
            logger.info('[media] ' + client.id + ' volume ' + playListId)
        })

        room.onMessage('switch', async (client, msg) => {
            logger.info('[media] ' + client.id + ' requested to switch ' + msg.playListId + ' by user: ' + msg.userToken)
            const userToken = msg.userToken
            if (adminUserTokens.indexOf(userToken) < 0) {
                return
            }
            const playListId = msg.playListId
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
            logger.info('[media] ' + client.id + ' switch ' + playListId)
        })
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