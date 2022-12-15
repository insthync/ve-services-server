import { Room, Client } from "colyseus";
import winston from "winston";
import { getLogger, getMediaService } from "..";
import { MediaService } from "../services/MediaService";
import { MediaRoomState } from "./schema/MediaRoomState";

export class MediaRoom extends Room<MediaRoomState> {
  private logger: winston.Logger;
  private mediaService: MediaService;

  onCreate (options: any) {
    this.logger = getLogger();
    this.mediaService = getMediaService();
    this.setState(new MediaRoomState());

  }

  onJoin (client: Client, options: any) {
    this.logger.info(`[media] ${client.sessionId} joined!`);
  }

  onLeave (client: Client, consented: boolean) {
    this.logger.info(`[media] ${client.sessionId} left!`);
  }

  onDispose () {
    this.logger.info(`[media] ${this.roomId} "disposing...`);
  }

}
