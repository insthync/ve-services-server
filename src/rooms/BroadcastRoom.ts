import { Room, Client, ServerError } from "colyseus";
import http from "http";
import winston from "winston";
import { getLogger } from "..";

export class BroadcastRoom extends Room {
  private logger: winston.Logger;

  onCreate(options: any) {
    this.logger = getLogger();
    this.autoDispose = false;
    this.maxClients = Number(process.env.MAX_CLIENTS || 500);
    this.onMessage("all", (client, message) => this.onAll(this, client, message));
    this.onMessage("other", (client, message) => this.onOther(this, client, message));
    this.logger.info(`[broadcast] ${this.roomId} "created`);
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
      this.logger.error(`[broadcast] ${client.sessionId} joining failed, wrong secret!`)
      throw new ServerError(400, "Unauthorized");
    }
    return options;
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
