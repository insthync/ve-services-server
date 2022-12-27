import { Room, Client, ServerError } from "colyseus";
import http from "http";
import winston from "winston";
import { getLogger, getChatService } from "..";
import { ChatService } from "../services/ChatService";
import { ChatRoomState } from "./schema/ChatRoomState";

export class ChatRoom extends Room<ChatRoomState> {
  private logger: winston.Logger;
  private chatService: ChatService;

  onCreate(options: any) {
    this.logger = getLogger();
    this.chatService = getChatService();
    this.chatService.onCreateRoom(this);
    this.setState(new ChatRoomState());
    this.autoDispose = false;
    this.logger.info(`[chat] ${this.roomId} "created`);
  }

  onJoin(client: Client, options: any) {
    this.logger.info(`[chat] ${client.sessionId} joined!`);
  }

  onLeave(client: Client, consented: boolean) {
    this.logger.info(`[chat] ${client.sessionId} left!`);
  }

  onDispose() {
    this.logger.info(`[chat] ${this.roomId} "disposing...`);
  }

}
