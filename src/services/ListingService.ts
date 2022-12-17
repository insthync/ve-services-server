import winston from "winston";
import express from "express";
import { Client } from "colyseus";
import { ListingRoom } from "../rooms/ListingRoom";

export class ListingService {
    private app: express.Express;
    private logger: winston.Logger;
    private gameServers: { [id: string]: IGameServerData } = {};

    constructor(app: express.Express, logger: winston.Logger) {
        this.app = app;
        this.logger = logger;
        this.setupRoutes();
    }

    setupRoutes() {
        const app = this.app;
        const gameServers = this.gameServers;

        app.get('/listing', (req, res) => {
            const result = [];
            for (const key in gameServers) {
                if (Object.hasOwnProperty.call(gameServers, key)) {
                    result.push(gameServers[key]);
                }
            }
            res.status(200).send({
                success: true,
                gameServers: result,
            });
        });

        app.get('/listing/totalPlayer', (req, res) => {
            let totalPlayer = 0;
            for (const key in gameServers) {
                if (Object.hasOwnProperty.call(gameServers, key)) {
                    totalPlayer += gameServers[key].currentPlayer;
                }
            }
            res.status(200).send({
                success: true,
                totalPlayer,
            });
        });
    }

    public onCreateRoom(room: ListingRoom) {
        const gameServers = this.gameServers;

        room.onMessage('update', (client: Client, msg: any) => {
            const id = client.id;
            if (id !== undefined && id in gameServers) {
                const gameServer: IGameServerData = {
                    id: msg.id,
                    address: msg.address,
                    port: msg.port,
                    title: msg.title,
                    description: msg.description,
                    map: msg.map,
                    currentPlayer: msg.currentPlayer,
                    maxPlayer: msg.maxPlayer,
                };
                gameServers[id] = gameServer;
            }
        });
    }

    public onConnect(client: Client, options: any) {
        const logger = this.logger;
        const gameServer: IGameServerData = {
            id: client.id,
            address: options.address,
            port: options.port,
            title: options.title,
            description: options.description,
            map: options.map,
            currentPlayer: options.currentPlayer,
            maxPlayer: options.maxPlayer,
        };
        this.gameServers[gameServer.id] = gameServer;
        logger.info(`[listing] Game-Server: ${client.id} connected.`);
    }

    public onDisconnect(client: Client) {
        const logger = this.logger;
        const id = client.id;
        if (id !== undefined && id in this.gameServers) {
            delete this.gameServers[id];
            logger.info(`[listing] Game-Server: ${id} shutdown.`);
        } else {
            logger.info(`[listing] No connected Game-Server: ${id}, so it can be shutdown.`);
        }
    }
}

interface IGameServerData {
    id: string,
    address: string,
    port: number,
    title: string,
    description: string,
    map: string,
    currentPlayer: number,
    maxPlayer: number,
}