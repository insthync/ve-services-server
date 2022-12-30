import { Room, Client, ServerError } from "colyseus";
import http from "http";
import winston from "winston";
import { getLogger, getMediaService } from "..";
import { MediaService } from "../services/MediaService";

export class MediaRoom extends Room {
    private logger: winston.Logger;
    private mediaService: MediaService;

    onCreate(options: any) {
        this.logger = getLogger();
        this.mediaService = getMediaService();
        this.mediaService.onCreateRoom(this);
        this.autoDispose = false;
        this.maxClients = Number(process.env.MAX_CLIENTS || 500);
        this.logger.info(`[media] ${this.roomId} "created`);
    }

    onAuth(client: Client, options: any, request: http.IncomingMessage) {
        this.mediaService.onAuth(client, options);
        return options;
    }

    onJoin(client: Client, options: any) {
        this.logger.info(`[media] ${client.sessionId} joined!`);
    }

    onLeave(client: Client, consented: boolean) {
        this.mediaService.onDisconnect(client);
        this.logger.info(`[media] ${client.sessionId} left!`);
    }

    onDispose() {
        this.logger.info(`[media] ${this.roomId} "disposing...`);
    }

}
