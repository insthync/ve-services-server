import { Room, Client, ServerError } from "colyseus";
import http from "http";
import winston from "winston";
import { getLogger } from "..";
import { ListingRoomState } from "./schema/ListingRoomState";

export class ListingRoom extends Room<ListingRoomState> {
  private logger: winston.Logger;

  onCreate(options: any) {
    this.logger = getLogger();
    this.setState(new ListingRoomState());

  }

  onAuth(client: Client, options: any, request: http.IncomingMessage) {
    const secretKeys = JSON.parse(process.env.SECRET_KEYS || "[]")
    if (secretKeys.indexOf(options.secret) < 0) {
      throw new ServerError(400, "Unauthorized");
    }
  }

  onJoin(client: Client, options: any) {
    this.logger.info(`[broadcast] ${client.sessionId} joined!`);
  }

  onLeave(client: Client, consented: boolean) {
    this.logger.info(`[broadcast] ${client.sessionId} left!`);
  }

  onDispose() {
    this.logger.info(`[broadcast] ${this.roomId} "disposing...`);
  }

}
