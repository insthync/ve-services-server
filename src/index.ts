import http from "http";
import https from "https";
import fs from "fs";
import bodyParser from "body-parser";
import express from "express";
import { matchMaker, Server, LocalPresence, RedisPresence, MatchMakerDriver } from "colyseus";
import { MongooseDriver } from "@colyseus/mongoose-driver"
import { RedisDriver } from "@colyseus/redis-driver";
import { monitor } from "@colyseus/monitor";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Profanity, ProfanityOptions } from '@2toad/profanity';
import cors from "cors";
import morgan from "morgan";
import winston from "winston";
import 'dotenv/config'
import { ChatService } from "./services/ChatService";
import { ListingService } from "./services/ListingService";
import { MediaService } from "./services/MediaService";

const logger: winston.Logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    defaultMeta: { service: 'user-service' },
    transports: [
        //
        // - Write all logs with importance level of `error` or less to `error.log`
        // - Write all logs with importance level of `info` or less to `combined.log`
        //
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
    ],
});

let chatService: ChatService;
let listingService: ListingService;
let mediaService: MediaService;

if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.simple(),
    }));
}

export function isTestModeEnabled(): boolean {
    return process.env.ENABLE_TEST_MODE ? (Number(process.env.ENABLE_TEST_MODE!) > 0) : false;
}

export function getLogger(): winston.Logger {
    return logger;
}

export function getChatService(): ChatService {
    return chatService;
}

export function getListingService(): ListingService {
    return listingService;
}

export function getMediaService(): MediaService {
    return mediaService;
}

const profanityoptions = new ProfanityOptions();
profanityoptions.wholeWord = false;
profanityoptions.grawlix = '*****';
profanityoptions.grawlixChar = '$';

export function getProfanity(): Profanity {
    const profanity = new Profanity(profanityoptions);
    const badWords: Array<string> = JSON.parse(process.env.BAD_WORDS || '[]');
    profanity.addWords(badWords);
    const whitelistWords: Array<string> = JSON.parse(process.env.WHITELIST_WORDS || '[]');
    profanity.whitelist.addWords(whitelistWords);
    return profanity;
}

const PORT = (process.env.PORT ? Number(process.env.PORT!) : 2567) + (process.env.NODE_APP_INSTANCE ? Number(process.env.NODE_APP_INSTANCE!) : 0);
// Presence
const USE_REDIS_PRESENCE = process.env.USE_REDIS_PRESENCE ? (Number(process.env.USE_REDIS_PRESENCE!) > 0) : false;
const REDIS_PRESENCE_HOST = process.env.REDIS_PRESENCE_HOST;
const REDIS_PRESENCE_PORT = process.env.REDIS_PRESENCE_PORT ? Number(process.env.REDIS_PRESENCE_PORT!) : undefined;
const REDIS_PRESENCE_PASSWORD = process.env.REDIS_PRESENCE_PASSWORD ? process.env.REDIS_PRESENCE_PASSWORD : undefined;
const REDIS_PRESENCE_DB = process.env.REDIS_PRESENCE_DB ? process.env.REDIS_PRESENCE_DB : undefined;
// Match maker
const USE_MATCH_MAKER_DRIVER = process.env.USE_MATCH_MAKER_DRIVER ? Number(process.env.USE_MATCH_MAKER_DRIVER!) : 0;
const MANGO_DRIVER_CONNECTION_STRING = process.env.MANGO_DRIVER_CONNECTION_STRING ? process.env.MANGO_DRIVER_CONNECTION_STRING : undefined;
const REDIS_DRIVER_HOST = process.env.REDIS_DRIVER_HOST;
const REDIS_DRIVER_PORT = process.env.REDIS_DRIVER_PORT ? Number(process.env.REDIS_DRIVER_PORT!) : undefined;
const REDIS_DRIVER_PASSWORD = process.env.REDIS_DRIVER_PASSWORD ? process.env.REDIS_DRIVER_PASSWORD : undefined;
const REDIS_DRIVER_DB = process.env.REDIS_DRIVER_DB ? process.env.REDIS_DRIVER_DB : undefined;

function setup(app: express.Express, server: http.Server): Server {
    logger.info(`Setup port ${PORT}`);
    logger.info(`Use redis? ${USE_REDIS_PRESENCE} @ ${REDIS_PRESENCE_HOST} port ${REDIS_PRESENCE_PORT} password ${REDIS_PRESENCE_PASSWORD} db ${REDIS_PRESENCE_DB}`);
    logger.info(`Use matchmaker-driver? ${USE_MATCH_MAKER_DRIVER}`);
    let matchMakerDriver: MatchMakerDriver = undefined;
    if (USE_MATCH_MAKER_DRIVER == 1) {
        // MongoDB
        logger.info(`Use MongoDB matchmaker-driver @ ${MANGO_DRIVER_CONNECTION_STRING}`);
        matchMakerDriver = new MongooseDriver(MANGO_DRIVER_CONNECTION_STRING);
    } else if (USE_MATCH_MAKER_DRIVER == 2) {
        // Redis
        logger.info(`Use Redis matchmaker-driver @ ${REDIS_DRIVER_HOST} port ${REDIS_DRIVER_PORT} password ${REDIS_DRIVER_PASSWORD} db ${REDIS_DRIVER_DB}`);
        matchMakerDriver = new RedisDriver({
            host: REDIS_DRIVER_HOST,
            port: REDIS_DRIVER_PORT,
            password: REDIS_DRIVER_PASSWORD,
            db: REDIS_DRIVER_DB,
        });
    }
    const gameServer = new Server({
        transport: new WebSocketTransport({ server }),
        presence: !USE_REDIS_PRESENCE ? new LocalPresence() : new RedisPresence({
            host: REDIS_PRESENCE_HOST,
            port: REDIS_PRESENCE_PORT,
            password: REDIS_PRESENCE_PASSWORD,
        }),
        driver: matchMakerDriver,
    });

    /**
     * Define your room handlers:
     */

    /**
     * Bind your custom express routes here:
     */
    app.get("/", (req, res) => {
        res.send("It's time to kick ass and chew bubblegum!");
    });

    // Chat
    chatService = new ChatService(app, logger, getProfanity());

    // Listing
    listingService = new ListingService(app, logger);

    // Media
    mediaService = new MediaService(app, logger);

    /**
     * Bind @colyseus/monitor
     * It is recommended to protect this route with a password.
     * Read more: https://docs.colyseus.io/tools/monitor/
     */
    app.use("/colyseus", monitor());

    return gameServer;
}


const app = express();
// support parsing of application/json type post data
app.use(bodyParser.json());
//support parsing of application/x-www-form-urlencoded post data
app.use(bodyParser.urlencoded({ extended: true }));
app.use(morgan('combined', { stream: logger }));
app.use(cors());
app.use(function(req, res, next) {
    res.setHeader('Vary', 'Origin')
    next();
});

const useHttps = Number(process.env.USE_HTTPS || 0) > 0;
if (useHttps) {
    const keyFilePath = process.env.HTTPS_KEY_FILE_PATH!;
    const certFilePath = process.env.HTTPS_CERT_FILE_PATH!;
    const server = https.createServer({
        key: fs.readFileSync(keyFilePath),
        cert: fs.readFileSync(certFilePath),
    }, app);
    const gameServer = setup(app, server);
    gameServer.listen(PORT, "0.0.0.0", undefined, () => logger.info(`Listening on https://{address}:${PORT}, (use https)`));
} else {
    const server = http.createServer(app);
    const gameServer = setup(app, server);
    gameServer.listen(PORT, "0.0.0.0", undefined, () => logger.info(`Listening on http://{address}:${PORT}`));
}
