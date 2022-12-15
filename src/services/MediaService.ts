import winston from "winston";
import express from "express";
import fileupload from 'express-fileupload'
import { PrismaClient } from '@prisma/client'
import { nanoid } from "nanoid";
import { getVideoDurationInSeconds } from 'get-video-duration'

export class MediaService {
    private app: express.Express;
    private logger: winston.Logger;
    private prisma: PrismaClient;
    private playLists: { [id: string]: any } = {}
    private playListSubscribers: { [id: string]: any[] } = {}
    private deletingMediaIds: string[] = []
    private adminUserTokens: string[] = []

    constructor(app: express.Express, logger: winston.Logger) {
        this.app = app;
        this.logger = logger;
        this.prisma = new PrismaClient();

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
                            currentPlayListSubscriber.emit('resp', {
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
}