import { Room, Client } from "colyseus";
import winston from "winston";
import { getLogger, getMediaService } from "..";
import { MediaService } from "../services/MediaService";
import { MediaRoomState } from "./schema/MediaRoomState";

export class MediaRoom extends Room<MediaRoomState> {
    private logger: winston.Logger;
    private mediaService: MediaService;

    onCreate(options: any) {
        const logger = getLogger();
        const mediaService = this.mediaService = getMediaService();
        this.setState(new MediaRoomState());

        function sendResp(socket: Client, playListId: any, currentPlayList: any) {
            socket.send('resp', {
                playListId: playListId,
                mediaId: currentPlayList.mediaId,
                isPlaying: currentPlayList.isPlaying,
                filePath: currentPlayList.filePath,
                time: currentPlayList.time,
                volume: currentPlayList.volume,
                duration: currentPlayList.duration,
            })
        }

        this.onMessage('sub', (socket, msg) => {
            logger.info('[media]' + socket.id + ' requested to sub ' + msg.playListId)
            const playListId = msg.playListId
            if (!Object.hasOwnProperty.call(mediaService.playListSubscribers, playListId)) {
                mediaService.playListSubscribers[playListId] = []
            }
            const currentPlayListSubscribers = mediaService.playListSubscribers[playListId]
            if (currentPlayListSubscribers.indexOf(socket) < 0) {
                currentPlayListSubscribers.push(socket)
                logger.info('[media]' + socket.id + ' sub ' + playListId)
            }
            // Find the playlist, if found then `resp`
            if (!Object.hasOwnProperty.call(mediaService.playLists, playListId)) {
                return
            }
            const currentPlayList = mediaService.playLists[playListId]
            // Response current media to the client
            sendResp(socket, playListId, currentPlayList)
        })

        this.onMessage('play', (socket, msg) => {
            logger.info('[media]' + socket.id + ' requested to play ' + msg.playListId + ' by user: ' + msg.userToken)
            const userToken = msg.userToken
            if (mediaService.adminUserTokens.indexOf(userToken) < 0) {
                return
            }
            const playListId = msg.playListId
            if (!Object.hasOwnProperty.call(mediaService.playLists, playListId)) {
                return
            }
            const currentPlayList = mediaService.playLists[playListId]
            if (!Object.hasOwnProperty.call(mediaService.playListSubscribers, playListId)) {
                mediaService.playListSubscribers[playListId] = []
            }
            const currentPlayListSubscribers = mediaService.playListSubscribers[playListId]
            currentPlayList.isPlaying = true
            mediaService.playLists[playListId] = currentPlayList
            currentPlayListSubscribers.forEach(element => {
                sendResp(element, playListId, currentPlayList)
            })
            logger.info('[media]' + socket.id + ' play ' + playListId)
        })

        this.onMessage('pause', (socket, msg) => {
            logger.info('[media]' + socket.id + ' requested to pause ' + msg.playListId + ' by user: ' + msg.userToken)
            const userToken = msg.userToken
            if (mediaService.adminUserTokens.indexOf(userToken) < 0) {
                return
            }
            const playListId = msg.playListId
            if (!Object.hasOwnProperty.call(mediaService.playLists, playListId)) {
                return
            }
            const currentPlayList = mediaService.playLists[playListId]
            if (!Object.hasOwnProperty.call(mediaService.playListSubscribers, playListId)) {
                mediaService.playListSubscribers[playListId] = []
            }
            const currentPlayListSubscribers = mediaService.playListSubscribers[playListId]
            currentPlayList.isPlaying = false
            mediaService.playLists[playListId] = currentPlayList
            currentPlayListSubscribers.forEach(element => {
                sendResp(element, playListId, currentPlayList)
            })
            logger.info('[media]' + socket.id + ' pause ' + playListId)
        })

        this.onMessage('stop', (socket, msg) => {
            logger.info('[media]' + socket.id + ' requested to stop ' + msg.playListId + ' by user: ' + msg.userToken)
            const userToken = msg.userToken
            if (mediaService.adminUserTokens.indexOf(userToken) < 0) {
                return
            }
            const playListId = msg.playListId
            if (!Object.hasOwnProperty.call(mediaService.playLists, playListId)) {
                return
            }
            const currentPlayList = mediaService.playLists[playListId]
            if (!Object.hasOwnProperty.call(mediaService.playListSubscribers, playListId)) {
                mediaService.playListSubscribers[playListId] = []
            }
            const currentPlayListSubscribers = mediaService.playListSubscribers[playListId]
            currentPlayList.isPlaying = false
            currentPlayList.time = 0
            mediaService.playLists[playListId] = currentPlayList
            currentPlayListSubscribers.forEach(element => {
                sendResp(element, playListId, currentPlayList)
            })
            logger.info('[media]' + socket.id + ' stop ' + playListId)
        })

        this.onMessage('seek', (socket, msg) => {
            logger.info('[media]' + socket.id + ' requested to seek ' + msg.playListId + ' by user: ' + msg.userToken)
            const userToken = msg.userToken
            if (mediaService.adminUserTokens.indexOf(userToken) < 0) {
                return
            }
            const playListId = msg.playListId
            if (!Object.hasOwnProperty.call(mediaService.playLists, playListId)) {
                return
            }
            const currentPlayList = mediaService.playLists[playListId]
            if (!Object.hasOwnProperty.call(mediaService.playListSubscribers, playListId)) {
                mediaService.playListSubscribers[playListId] = []
            }
            const currentPlayListSubscribers = mediaService.playListSubscribers[playListId]
            currentPlayList.time = msg.time
            mediaService.playLists[playListId] = currentPlayList
            currentPlayListSubscribers.forEach(element => {
                sendResp(element, playListId, currentPlayList)
            })
            logger.info('[media]' + socket.id + ' seek ' + playListId)
        })

        this.onMessage('volume', (socket, msg) => {
            logger.info('[media]' + socket.id + ' requested to volume ' + msg.playListId + ' by user: ' + msg.userToken)
            const userToken = msg.userToken
            if (mediaService.adminUserTokens.indexOf(userToken) < 0) {
                return
            }
            const playListId = msg.playListId
            if (!Object.hasOwnProperty.call(mediaService.playLists, playListId)) {
                return
            }
            const currentPlayList = mediaService.playLists[playListId]
            if (!Object.hasOwnProperty.call(mediaService.playListSubscribers, playListId)) {
                mediaService.playListSubscribers[playListId] = []
            }
            const currentPlayListSubscribers = mediaService.playListSubscribers[playListId]
            currentPlayList.volume = msg.volume
            mediaService.playLists[playListId] = currentPlayList
            currentPlayListSubscribers.forEach(element => {
                sendResp(element, playListId, currentPlayList)
            })
            logger.info('[media]' + socket.id + ' volume ' + playListId)
        })

        this.onMessage('switch', async (socket, msg) => {
            logger.info('[media]' + socket.id + ' requested to switch ' + msg.playListId + ' by user: ' + msg.userToken)
            const userToken = msg.userToken
            if (mediaService.adminUserTokens.indexOf(userToken) < 0) {
                return
            }
            const playListId = msg.playListId
            if (!Object.hasOwnProperty.call(mediaService.playLists, playListId)) {
                return
            }
            const currentPlayList = mediaService.playLists[playListId]
            if (!Object.hasOwnProperty.call(mediaService.playListSubscribers, playListId)) {
                mediaService.playListSubscribers[playListId] = []
            }
            const mediaId = msg.mediaId
            const media = await mediaService.prisma.videos.findFirst({
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
            const currentPlayListSubscribers = mediaService.playListSubscribers[playListId]
            mediaService.playLists[playListId] = currentPlayList
            currentPlayListSubscribers.forEach(element => {
                sendResp(element, playListId, currentPlayList)
            })
            logger.info('[media]' + socket.id + ' switch ' + playListId)
        })
    }

    onJoin(client: Client, options: any) {
        this.logger.info(`[media] ${client.sessionId} joined!`);
    }

    onLeave(client: Client, consented: boolean) {
        this.logger.info(`[media] ${client.sessionId} left!`);
    }

    onDispose() {
        this.logger.info(`[media] ${this.roomId} "disposing...`);
    }

}
