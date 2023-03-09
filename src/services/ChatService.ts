import winston from "winston";
import express from "express";
import { Profanity } from "@2toad/profanity";
import { PrismaClient, Group, User } from '@prisma/client'
import { nanoid } from "nanoid";
import { Client } from "colyseus";
import { ChatRoom } from "../rooms/ChatRoom";

export class ChatService {
    private app: express.Express;
    private logger: winston.Logger;
    private profanity: Profanity;
    private prisma: PrismaClient;
    private connectingUsers: { [id: string]: IClientData } = {}
    private connections: { [id: string]: Client } = {}
    private connectionsByName: { [name: string]: Client } = {}
    private connectionsByGroupId: { [groupId: string]: { [id: string]: Client } } = {}

    constructor(app: express.Express, logger: winston.Logger, profanity: Profanity) {
        this.app = app;
        this.logger = logger;
        this.profanity = profanity;
        this.prisma = new PrismaClient();
        this.setupRoutes();
    }

    setupRoutes() {
        this.app.post("/chat/add-user", this.validateSystem.bind(this), this.onAddUser.bind(this));
        this.app.post("/chat/remove-user", this.validateSystem.bind(this), this.onRemoveUser.bind(this));
    }

    async onAddUser(req: express.Request, res: express.Response) {
        const connectionKey = nanoid();
        const connectingUser = {
            userId: req.body.userId,
            name: req.body.name,
            connectionKey: connectionKey,
            token: req.body.userId + "|" + connectionKey,
        } as IClientData
        this.connectingUsers[connectingUser.userId] = connectingUser
        const user = await this.prisma.user.findUnique({
            where: {
                userId: req.body.userId,
            }
        })
        if (user) {
            await this.prisma.user.update({
                where: {
                    userId: req.body.userId,
                },
                data: {
                    name: req.body.name,
                    iconUrl: req.body.iconUrl,
                }
            })
        } else {
            await this.prisma.user.create({
                data: {
                    userId: req.body.userId,
                    name: req.body.name,
                    iconUrl: req.body.iconUrl,
                }
            })
        }
        // Send response back
        res.status(200).send(connectingUser)
    }

    async onRemoveUser(req: express.Request, res: express.Response) {
        delete this.connectingUsers[req.body.userId]
        res.status(200).send()
    }

    validateSystem(req: express.Request, res: express.Response, next: express.NextFunction) {
        // This must be able to connect by game-server only, don't allow client to connect
        // Validate connection by secret key which will be included in header -> authorization
        const bearerHeader = req.headers['authorization']
        if (!bearerHeader) {
            res.sendStatus(400)
            return
        }
        // Substring `bearer `, length is 7
        const bearerToken = bearerHeader.substring(7)
        const secretKeys: string[] = JSON.parse(process.env.SECRET_KEYS || "[]")
        if (secretKeys.indexOf(bearerToken) < 0) {
            res.sendStatus(400)
            return
        }
        next();
    }

    async GroupLeave(groupId: string | undefined, userId: string | undefined) {
        // Validate group
        if (!groupId) {
            return
        }
        // Validate user
        if (!userId) {
            return
        }
        // Delete user's group data from database
        await this.prisma.userGroup.deleteMany({
            where: {
                userId: userId,
                groupId: groupId,
            }
        })
        // Valiate before send group moving message to clients
        if (!Object.prototype.hasOwnProperty.call(this.connectionsByGroupId, groupId)) {
            return
        }
        if (!Object.prototype.hasOwnProperty.call(this.connectionsByGroupId[groupId], userId)) {
            return
        }
        // Remove user from the group
        await this.NotifyGroup(userId)
        delete this.connectionsByGroupId[groupId][userId]
        // Broadcast leave member
        const targetClients = this.connectionsByGroupId[groupId]
        for (const targetUserId in targetClients) {
            const targetClient = targetClients[targetUserId]
            targetClient.send("group-leave", {
                groupId: groupId,
                userId: userId,
            } as IGroupLeaveResp)
        }
    }

    async NotifyGroupInvitation(userId: string) {
        const list = await this.prisma.userGroupInvitation.findMany({
            where: {
                userId: userId,
            }
        })
        const groupIds: Array<string> = []
        list.forEach(element => {
            groupIds.push(element.groupId)
        })
        const groupList = await this.prisma.group.findMany({
            where: {
                groupId: {
                    in: groupIds
                }
            }
        })
        if (Object.prototype.hasOwnProperty.call(this.connections, userId)) {
            const connection = this.connections[userId]
            connection.send("group-invitation-list", {
                list: groupList
            } as IGroupInvitationListResp)
        }
    }

    async NotifyGroupUser(userId: string, groupId: string) {
        const list = await this.prisma.userGroup.findMany({
            where: {
                groupId: groupId,
            }
        })
        const userIds: Array<string> = []
        list.forEach(element => {
            userIds.push(element.userId)
        })
        const userList = await this.prisma.user.findMany({
            where: {
                userId: {
                    in: userIds
                }
            }
        })

        if (Object.prototype.hasOwnProperty.call(this.connections, userId)) {
            const connection = this.connections[userId]
            connection.send("group-user-list", {
                groupId: groupId,
                list: userList
            } as IGroupUserListResp)
        }
    }

    async NotifyGroup(userId: string) {
        const list = await this.prisma.userGroup.findMany({
            where: {
                userId: userId,
            }
        })
        const groupIds: Array<string> = []
        list.forEach(element => {
            groupIds.push(element.groupId)
        })
        const groupList = await this.prisma.group.findMany({
            where: {
                groupId: {
                    in: groupIds
                }
            }
        })
        if (Object.prototype.hasOwnProperty.call(this.connections, userId)) {
            const connection = this.connections[userId]
            connection.send("group-list", {
                list: groupList
            } as IGroupListResp)
        }
    }

    async AddUserToGroup(userId: string, groupId: string) {
        await this.prisma.userGroup.deleteMany({
            where: {
                userId: userId,
                groupId: groupId,
            }
        })
        await this.prisma.userGroup.create({
            data: {
                userId: userId,
                groupId: groupId,
            }
        })
        if (!Object.prototype.hasOwnProperty.call(this.connectionsByGroupId, groupId)) {
            this.connectionsByGroupId[groupId] = {}
        }
        // Add user to group
        if (Object.prototype.hasOwnProperty.call(this.connections, userId)) {
            const socket = this.connections[userId]
            this.connectionsByGroupId[groupId][userId] = socket
        }
        // Broadcast new member
        const targetClients = this.connectionsByGroupId[groupId]
        for (const targetUserId in targetClients) {
            const targetClient = targetClients[targetUserId]
            targetClient.send("group-join", {
                groupId: groupId,
                userId: userId,
            } as IGroupJoinResp)
        }
        await this.NotifyGroupInvitation(userId)
        await this.NotifyGroup(userId)
    }

    public onCreateRoom(room: ChatRoom) {
        room.onMessage("local", this.onLocal.bind(this))
        room.onMessage("global", this.onGlobal.bind(this))
        room.onMessage("whisper", this.onWhisper.bind(this))
        room.onMessage("whisper-by-id", this.onWhisperById.bind(this))
        room.onMessage("group", this.onGroup.bind(this))
        room.onMessage("create-group", this.onCreateGroup.bind(this))
        room.onMessage("update-group", this.onUpdateGroup.bind(this))
        room.onMessage("group-invitation-list", this.onGroupInvitationList.bind(this))
        room.onMessage("group-user-list", this.onGroupUserList.bind(this))
        room.onMessage("group-list", this.onGroupList.bind(this))
        room.onMessage("group-invite", this.onGroupInvite.bind(this))
        room.onMessage("group-invite-accept", this.onGroupInviteAccept.bind(this))
        room.onMessage("group-invite-decline", this.onGroupInviteDecline.bind(this))
        room.onMessage("leave-group", this.onLeaveGroup.bind(this))
        room.onMessage("kick-user", this.onKickUser.bind(this))
    }

    async onLocal(client: Client, data: any) {
        const userId = client.userData.userId
        if (!userId) {
            return
        }
        for (const targetUserId in this.connections) {
            const targetClient = this.connections[targetUserId]
            targetClient.send("local", {
                userId: userId,
                name: client.userData.name,
                msg: this.profanity.censor(data.msg),
                map: data.map,
                x: data.x,
                y: data.y,
                z: data.z,
            } as IChatResp)
        }
    }

    async onGlobal(client: Client, data: any) {
        const userId = client.userData.userId
        if (!userId) {
            return
        }
        for (const targetUserId in this.connections) {
            const targetClient = this.connections[targetUserId]
            targetClient.send("global", {
                userId: userId,
                name: client.userData.name,
                msg: this.profanity.censor(data.msg),
            } as IChatResp)
        }
    }

    async onWhisper(client: Client, data: any) {
        const userId = client.userData.userId
        if (!userId) {
            return
        }
        const targetName = data.name
        if (!Object.prototype.hasOwnProperty.call(this.connectionsByName, targetName)) {
            return
        }
        const targetClient = this.connectionsByName[targetName]
        targetClient.send("whisper", {
            userId: userId,
            userId2: targetClient.userData.userId,
            name: client.userData.name,
            name2: targetClient.userData.name,
            msg: this.profanity.censor(data.msg),
        } as IChatResp)
        client.send("whisper", {
            userId: userId,
            userId2: targetClient.userData.userId,
            name: client.userData.name,
            name2: targetClient.userData.name,
            msg: this.profanity.censor(data.msg),
        } as IChatResp)
    }

    async onWhisperById(client: Client, data: any) {
        const userId = client.userData.userId
        if (!userId) {
            return
        }
        const targetUserId = data.userId
        if (!Object.prototype.hasOwnProperty.call(this.connections, targetUserId)) {
            return
        }
        const targetClient = this.connections[targetUserId]
        targetClient.send("whisper", {
            userId: userId,
            userId2: targetClient.userData.userId,
            name: client.userData.name,
            name2: targetClient.userData.name,
            msg: this.profanity.censor(data.msg),
        } as IChatResp)
        client.send("whisper", {
            userId: userId,
            userId2: targetClient.userData.userId,
            name: client.userData.name,
            name2: targetClient.userData.name,
            msg: this.profanity.censor(data.msg),
        } as IChatResp)
    }

    async onGroup(client: Client, data: any) {
        const userId = client.userData.userId
        if (!userId) {
            return
        }
        const groupId = data.groupId
        if (!groupId) {
            return
        }
        // Has the group?
        if (!Object.prototype.hasOwnProperty.call(this.connectionsByGroupId, groupId)) {
            return
        }
        // User is in the group?
        if (!Object.prototype.hasOwnProperty.call(this.connectionsByGroupId[groupId], userId)) {
            return
        }
        const targetClients = this.connectionsByGroupId[groupId]
        for (const targetUserId in targetClients) {
            const targetClient = targetClients[targetUserId]
            targetClient.send("group", {
                groupId: groupId,
                userId: userId,
                name: client.userData.name,
                msg: this.profanity.censor(data.msg),
            } as IChatResp)
        }
    }

    async onCreateGroup(client: Client, data: any) {
        const userId = client.userData.userId
        if (!userId) {
            return
        }
        const groupId = nanoid(8)
        const title = this.profanity.censor(data.title)
        const iconUrl = data.iconUrl
        // Insert group data to database
        await this.prisma.group.create({
            data: {
                groupId: groupId,
                title: title,
                iconUrl: iconUrl,
            }
        })
        // Add user to the group
        await this.prisma.userGroup.deleteMany({
            where: {
                userId: userId,
                groupId: groupId,
            }
        })
        await this.prisma.userGroup.create({
            data: {
                userId: userId,
                groupId: groupId,
            }
        })
        this.connectionsByGroupId[groupId] = {}
        this.connectionsByGroupId[groupId][userId] = client
        // Tell the client that the group was created
        client.send("create-group", {
            groupId: groupId,
            title: title,
            iconUrl: iconUrl,
        } as Group)
    }

    async onUpdateGroup(client: Client, data: any) {
        const userId = client.userData.userId
        if (!userId) {
            return
        }
        const groupId = data.groupId
        if (!groupId) {
            return
        }
        // Has the group?
        if (!Object.prototype.hasOwnProperty.call(this.connectionsByGroupId, groupId)) {
            return
        }
        // User is in the group?
        if (!Object.prototype.hasOwnProperty.call(this.connectionsByGroupId[groupId], userId)) {
            return
        }
        // Update group data at database
        const title = data.title
        const iconUrl = data.iconUrl
        await this.prisma.group.update({
            where: {
                groupId: groupId,
            },
            data: {
                title: title,
                iconUrl: iconUrl
            },
        })
        // Tell the clients that the group was updated
        const targetClients = this.connectionsByGroupId[groupId]
        for (const targetUserId in targetClients) {
            const targetClient = targetClients[targetUserId]
            targetClient.send("update-group", {
                groupId: groupId,
                title: title,
                iconUrl: iconUrl,
            } as Group)
        }
    }

    async onGroupInvitationList(client: Client, data: any) {
        const userId = client.userData.userId
        if (!userId) {
            return
        }
        await this.NotifyGroupInvitation(userId)
    }

    async onGroupUserList(client: Client, data: any) {
        const userId = client.userData.userId
        if (!userId) {
            return
        }
        const groupId = data.groupId
        if (!groupId) {
            return
        }
        await this.NotifyGroupUser(userId, groupId)
    }

    async onGroupList(client: Client, data: any) {
        const userId = client.userData.userId
        if (!userId) {
            return
        }
        await this.NotifyGroup(userId)
    }

    async onGroupInvite(client: Client, data: any) {
        const inviteId = client.userData.userId
        if (!inviteId) {
            return
        }
        const userId = data.userId
        if (!userId) {
            return
        }
        const groupId = data.groupId
        if (!groupId) {
            return
        }
        // Has the group?
        if (!Object.prototype.hasOwnProperty.call(this.connectionsByGroupId, groupId)) {
            return
        }
        // Inviter is in the group?
        if (!Object.prototype.hasOwnProperty.call(this.connectionsByGroupId[groupId], inviteId)) {
            return
        }
        let mode: Number = 0
        if (process.env.GROUP_USER_ADD_MODE) {
            mode = Number(process.env.GROUP_USER_ADD_MODE)
        }
        if (mode == 0) {
            // Create invitation
            await this.prisma.userGroupInvitation.deleteMany({
                where: {
                    userId: userId,
                    groupId: groupId,
                }
            })
            await this.prisma.userGroupInvitation.create({
                data: {
                    userId: userId,
                    groupId: groupId,
                }
            })
            await this.NotifyGroupInvitation(userId)
        } else {
            await this.AddUserToGroup(userId, groupId)
        }
    }

    async onGroupInviteAccept(client: Client, data: any) {
        const userId = client.userData.userId
        if (!userId) {
            return
        }
        const groupId = data.groupId
        if (!groupId) {
            return
        }
        // Validate invitation
        const countInvitation = await this.prisma.userGroupInvitation.count({
            where: {
                userId: userId,
                groupId: groupId,
            }
        })
        if (countInvitation == 0) {
            return
        }
        // Delete invitation
        await this.prisma.userGroupInvitation.deleteMany({
            where: {
                userId: userId,
                groupId: groupId,
            }
        })
        // Add user to the group
        await this.AddUserToGroup(userId, groupId)
    }

    async onGroupInviteDecline(client: Client, data: any) {
        const userId = client.userData.userId
        if (!userId) {
            return
        }
        const groupId = data.groupId
        if (!groupId) {
            return
        }
        // Validate invitation
        const countInvitation = await this.prisma.userGroupInvitation.count({
            where: {
                userId: userId,
                groupId: groupId,
            }
        })
        if (countInvitation == 0) {
            return
        }
        // Delete invitation
        await this.prisma.userGroupInvitation.deleteMany({
            where: {
                userId: userId,
                groupId: groupId,
            }
        })
        await this.NotifyGroupInvitation(userId)
    }

    async onLeaveGroup(client: Client, data: any) {
        await this.GroupLeave(data.groupId, client.userData.userId)
    }

    async onKickUser(client: Client, data: any) {
        await this.GroupLeave(data.groupId, data.userId)
    }

    public async onAuth(client: Client, options: any) {
        const token = options.token
        if (!token) {
            return
        }

        const splitingData = token.split("|")
        if (splitingData.length < 2) {
            return
        }

        const userId = splitingData[0]
        const connectionKey = splitingData[1]
        if (!userId) {
            return
        }
        
        if (!Object.prototype.hasOwnProperty.call(this.connectingUsers, userId)) {
            return
        }

        const connectingUser = this.connectingUsers[userId]
        if (connectionKey != connectingUser.connectionKey) {
            return
        }

        // Disconnect older socket
        if (Object.prototype.hasOwnProperty.call(this.connections, userId)) {
            this.connections[userId].leave()
            this.logger.info(`[chat] Disconnect [${this.connections[userId].id}] because it is going to connect by newer client with the same user ID`)
        }

        // Set user data after connected
        client.userData = connectingUser

        // Set socket client to the collections
        this.connections[userId] = client
        this.connectionsByName[connectingUser.name] = client

        // Find and store user groups
        const userGroups = await this.prisma.userGroup.findMany({
            where: {
                userId: userId
            }
        })
        userGroups.forEach(userGroup => {
            if (!Object.prototype.hasOwnProperty.call(this.connectionsByGroupId, userGroup.groupId)) {
                this.connectionsByGroupId[userGroup.groupId] = {}
            }
            this.connectionsByGroupId[userGroup.groupId][userId] = client
        })

        await this.NotifyGroup(userId)
    }
}

interface IClientData {
    userId: string;
    name: string;
    connectionKey: string;
    token: string;
}

interface IGroupLeaveResp {
    groupId: string;
    userId: string;
}

interface IGroupInvitationListResp {
    list: Group[];
}

interface IGroupUserListResp {
    groupId: string;
    list: User[];
}

interface IGroupListResp {
    list: Group[];
}

interface IGroupJoinResp {
    groupId: string;
    userId: string;
}

interface IChatResp {
    groupId?: string;
    userId: string;
    userId2?: string;
    name: string;
    name2?: string
    msg: string;
    map?: string;
    x?: number;
    y?: number;
    z?: number;
}