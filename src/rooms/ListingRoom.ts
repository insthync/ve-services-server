import { Room, Client, ServerError } from "colyseus";
import http from "http";
import winston from "winston";
import { getLogger, getListingService } from "..";
import { ListingService } from "../services/ListingService";
import { ListingRoomState } from "./schema/ListingRoomState";

export class ListingRoom extends Room<ListingRoomState> {
  private logger: winston.Logger;
  private listingService: ListingService;

  onCreate(options: any) {
    this.logger = getLogger();
    this.listingService = getListingService();
    this.listingService.onCreateRoom(this);
    this.setState(new ListingRoomState());
    this.autoDispose = false;
    this.logger.info(`[listing] ${this.roomId} "created`);
  }

  onAuth(client: Client, options: any, request: http.IncomingMessage) {
    const secretKeys = JSON.parse(process.env.SECRET_KEYS || "[]")
    if (secretKeys.indexOf(options.secret) < 0) {
      throw new ServerError(400, "Unauthorized");
    }
  }

  onJoin(client: Client, options: any) {
    this.listingService.onConnect(client, options);
    this.logger.info(`[listing] ${client.sessionId} joined!`);
  }

  onLeave(client: Client, consented: boolean) {
    this.listingService.onDisconnect(client);
    this.logger.info(`[listing] ${client.sessionId} left!`);
  }

  onDispose() {
    this.logger.info(`[listing] ${this.roomId} "disposing...`);
  }

}
