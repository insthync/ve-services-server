import { Room, Client, ServerError } from "colyseus";
import http from "http";
import winston from "winston";
import { getLogger } from "..";
import { BroadcastState } from "./schema/BroadcastState";

export class BroadcastRoom extends Room<BroadcastState> {
  private logger: winston.Logger;

  onCreate(options: any) {
    this.logger = getLogger();
    this.setState(new BroadcastState());

    this.onMessage("all", (client, message) => this.onAll(this, client, message));
    this.onMessage("other", (client, message) => this.onOther(this, client, message));
  }

  onAll(self: BroadcastRoom, client: Client, message: any) {
    self.broadcast("all", message);
  }

  onOther(self: BroadcastRoom, client: Client, message: any) {
    self.broadcast("other", message, { except: client });
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
