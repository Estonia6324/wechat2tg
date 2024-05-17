import * as QRCode from 'qrcode'
import {ScanStatus, WechatyBuilder} from 'wechaty'
import * as PUPPET from 'wechaty-puppet'
import {
    ContactImpl,
    ContactInterface,
    FriendshipImpl,
    FriendshipInterface,
    MessageInterface,
    RoomInterface,
    WechatyInterface,
    RoomInvitationInterface
} from 'wechaty/impls'
import {TelegramBotClient} from './TelegramBotClient'
import {EmojiConverter} from '../utils/EmojiUtils'
import {MemberCacheType} from '../models/TgCache'
import {SimpleMessage} from '../models/Message'
import {TalkerEntity} from '../models/TalkerCache'
import {UniqueIdGenerator} from '../utils/IdUtils'
import {NotionMode, VariableType} from '../models/Settings'
import {FriendshipItem} from '../models/FriendshipItem'
import {MessageUtils} from '../utils/MessageUtils'
import {FileBox, type FileBoxInterface} from 'file-box'
import * as fs from 'fs'
import {Buffer} from 'node:buffer'
import {CustomFile} from 'telegram/client/uploads'
import {RoomItem} from '../models/RoomItem'
import {ContactItem} from '../models/ContactItem'
import {BindItem} from '../models/BindItem'
import {BindItemService} from '../service/BindItemService'
// import {FmtString} from "telegraf/format";

// import type {FriendshipInterface} from "wechaty/src/user-modules/mod";


export class WeChatClient {


    constructor(private readonly tgClient: TelegramBotClient) {
        this._client = WechatyBuilder.build({
            name: './storage/wechat_bot',
            puppet: 'wechaty-puppet-wechat4u',
            puppetOptions: {
                uos: true
            }
        })
        this._tgClient = tgClient
        this._contactMap = new Map<number, Set<ContactItem>>([
            [0, new Set<ContactItem>()],
            [1, new Set<ContactItem>()],
            [2, new Set<ContactItem>()],
            [3, new Set<ContactItem>()]
        ])

        this.scan = this.scan.bind(this)
        this.message = this.message.bind(this)
        this.start = this.start.bind(this)
        this.friendship = this.friendship.bind(this)
        this.init = this.init.bind(this)
        this.logout = this.logout.bind(this)
        this.login = this.login.bind(this)
        this.onReady = this.onReady.bind(this)
        this.roomTopic = this.roomTopic.bind(this)
        this.roomJoin = this.roomJoin.bind(this)
        this.roomLeave = this.roomLeave.bind(this)
        this.roomInvite = this.roomInvite.bind(this)
    }

    private readonly _client: WechatyInterface
    private readonly _tgClient: TelegramBotClient

    private _contactMap: Map<number, Set<ContactItem>> | undefined
    private _roomList: RoomItem[] = []

    private _selectedContact: ContactInterface [] = []
    private _selectedRoom: RoomInterface [] = []
    private _memberCache: MemberCacheType[] = []
    private scanMsgId: number | undefined = undefined

    private _started = false
    private _cacheMemberDone = false
    private _cacheMemberSendMessage = false
    private _friendShipList: FriendshipItem[] = []
    private loadMsg: number | undefined = undefined

    public get contactMap(): Map<number, Set<ContactItem>> | undefined {
        return this._contactMap
    }

    public set contactMap(contactMap: Map<number, Set<ContactItem>> | undefined) {
        this._contactMap = contactMap
    }

    get friendShipList(): FriendshipItem[] {
        return this._friendShipList
    }

    set friendShipList(value: FriendshipItem[]) {
        this._friendShipList = value
    }

    get cacheMemberSendMessage(): boolean {
        return this._cacheMemberSendMessage
    }

    set cacheMemberSendMessage(value: boolean) {
        this._cacheMemberSendMessage = value
    }

    get cacheMemberDone(): boolean {
        return this._cacheMemberDone
    }

    set cacheMemberDone(value: boolean) {
        this._cacheMemberDone = value
    }

    get memberCache(): MemberCacheType[] {
        return this._memberCache
    }

    set memberCache(value: MemberCacheType[]) {
        this._memberCache = value
    }

    get roomList(): RoomItem[] {
        return this._roomList
    }

    set roomList(value: RoomItem[]) {
        this._roomList = value
    }

    get selectedRoom(): RoomInterface[] {
        return this._selectedRoom
    }

    set selectedRoom(value: RoomInterface[]) {
        this._selectedRoom = value
    }

    get selectedContact(): ContactInterface[] {
        return this._selectedContact
    }

    set selectedContact(value: ContactInterface[]) {
        this._selectedContact = value
    }

    public get client() {
        return this._client
    }

    public async start() {
        this.init()
        if (this._client === null) {
            return
        }
        // if(this._client.ready().then())
        if (!this._started) {
            await this._client.start().then(() => {
                this._started = true
                console.log('Wechat client start!')
            })
        } else {
            console.log('Wechat client already started!')
            return new Error('Wechat client already started!')
        }
    }

    private init() {
        if (this._client === null) return
        this._client.on('login', this.login)
            .on('scan', this.scan)
            .on('message', this.message)
            .on('logout', this.logout)
            .on('stop', () => console.log('on stop...'))
            .on('post', () => console.log('on post...'))
            .on('room-join', this.roomJoin)
            .on('room-topic', this.roomTopic)
            .on('room-leave', this.roomLeave)
            .on('room-invite', this.roomInvite)
            .on('friendship', this.friendship)
            .on('ready', this.onReady)
            .on('error', this.error)
    }

    private roomInvite(roomInvitation: RoomInvitationInterface) {
        this._tgClient.sendMessage({
            sender: '未知用户 type 没有',
            body: '邀请你加入群聊(无法获取用户名和群名)',
            id: roomInvitation.id,
            chatId: this.tgClient.chatId
        })
    }

    private error(error: Error) {
        console.error('error:', error)
    }

    private friendship(friendship: FriendshipInterface) {
        const contact = friendship.contact()
        const hello = friendship.hello()
        if (friendship.type() === FriendshipImpl.Type.Receive) {
            const id = UniqueIdGenerator.getInstance().generateId('friendship-accept')
            this._friendShipList.push(new FriendshipItem(id, friendship))
            this._tgClient.bot.telegram.sendMessage(
                this._tgClient.chatId, `👤${contact.name()}请求添加您为好友:\n${hello}`,
                {
                    reply_markup: {
                        inline_keyboard:
                            [
                                [
                                    {text: '接受', callback_data: `${id}`},
                                ]
                            ]
                    }
                })
        }
        if (friendship.type() === FriendshipImpl.Type.Confirm) {
            const type = contact.type()
            const id = UniqueIdGenerator.getInstance().generateId('contact')
            switch (type) {
                case ContactImpl.Type.Unknown:
                    this.contactMap?.get(ContactImpl.Type.Unknown)?.add({id:id,contact:contact})
                    break
                case ContactImpl.Type.Individual:
                    this.contactMap?.get(ContactImpl.Type.Individual)?.add({id:id,contact:contact})
                    break
                case ContactImpl.Type.Official:
                    this.contactMap?.get(ContactImpl.Type.Official)?.add({id:id,contact:contact})
                    break
                case ContactImpl.Type.Corporation:
                    this.contactMap?.get(ContactImpl.Type.Corporation)?.add({id:id,contact:contact})
                    break
            }
        }
    }

    private roomJoin(room: RoomInterface, inviteeList: ContactInterface[], inviter: ContactInterface) {
        inviteeList.forEach(item => {
            if (item.self()) {
                const item = this._roomList.find(it => it.id === room.id)
                if (!item) {
                    const id = UniqueIdGenerator.getInstance().generateId('room')
                    this.roomList.push({room:room,id:id})
                }
            }
        })
    }

    private roomLeave(room: RoomInterface, leaverList: ContactInterface[]) {
        leaverList.forEach(leaver => {
            if (leaver.self()) {
                this._roomList = this._roomList.filter(it => it.id != room.id)
            }
        })
    }

    private roomTopic(room: RoomInterface, topic: string, oldTopic: string, changer: ContactInterface) {
        const item = this._roomList.find(it => it.room.id === room.id)
        if (item) {
            if (item.room.payload?.topic !== topic) {
                this._roomList[this._roomList.indexOf(item)].room.sync()
            }
        }
    }

    private onReady() {
        console.log('Wechat client ready!')
        this.cacheMember().then(() => {
            this.cacheMemberDone = true
            if (!this.cacheMemberSendMessage) {
                this.cacheMemberSendMessage = true
                this._tgClient.bot.telegram.editMessageText(this._tgClient.chatId, this.loadMsg, undefined, '联系人加载完成').then(msg => {
                    setTimeout(() => {
                        if (this.loadMsg) {
                            this._tgClient.bot.telegram.deleteMessage(this._tgClient.chatId, this.loadMsg)
                        }
                    }, 10 * 1000)
                })
            }
            console.log('cache member done!')
        })
    }

    public async stop() {
        await this._client.stop().then(() => this._started = false)
        // console.log('stop ... ')
    }

    public restart() {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        this._client.restart().then(() => {
            console.log('restart ... ')
        })
    }

    public reset() {
        // this._client.reset().then(() => {
        console.log('reset ... ')
        // })
        this._client.logout()
    }

    public async logout() {
        // this._client.logout();
        // this._client.reset().then()

        this.resetValue()
    }

    private login() {
        if (this._client.isLoggedIn) {
            this._tgClient.bot.telegram.sendMessage(this._tgClient.chatId, '登录成功!').then(() => {
                // this._client.Contact.findAll()
                // this._client.Room.findAll()
                // this._client.Room.find({id: ''})
                // 重新登陆就要等待加载
                this.cacheMemberDone = false
                this.cacheMemberSendMessage = false


                this._tgClient.bot.telegram.sendMessage(this._tgClient.chatId, '正在加载联系人...').then(value => {
                    this.loadMsg = value.message_id
                })
            })
            // // 登陆后就缓存所有的联系人和房间
            // this._tgClient.setAllMemberCache().then(() => {
            //     this._tgClient.calcShowMemberList()
            // });
            if (this.scanMsgId) {
                this._tgClient.bot.telegram.deleteMessage(this._tgClient.chatId, this.scanMsgId)
                this.scanMsgId = undefined
            }
        } else {
            this._tgClient.bot.telegram.sendMessage(this._tgClient.chatId, '登录失败!')
        }
    }

    // scan qrcode login
    private scan(qrcode: string, status: ScanStatus) {
        console.log('---------on scan---------')
        if (status === ScanStatus.Waiting || status === ScanStatus.Timeout) {
            const qrcodeImageUrl = encodeURIComponent(qrcode)

            console.info('StarterBot', 'onScan: %s(%s) - %s', ScanStatus[status], status, qrcodeImageUrl)

            // console.log(this._bot)
            const tgBot = this._tgClient.bot
            // tgBot.telegram.sendMessage(this._tgClient.chatId, '请扫码登陆')
            // console.log('chat id is : {}', this._tgClient.chatId)
            // if (!this._started) {
            QRCode.toBuffer(qrcode).then(buff =>
                tgBot.telegram.sendPhoto(this._tgClient.chatId, {source: buff}, {caption: '请扫码登陆:'})).then(msg => {
                if (this.scanMsgId) {
                    tgBot.telegram.deleteMessage(this._tgClient.chatId, this.scanMsgId)
                }
                this.scanMsgId = msg.message_id
            })
            // }

        } else {
            console.info('StarterBot', 'onScan: %s(%s)', ScanStatus[status], status)
        }
    }

    private async message(message: MessageInterface) {
        const talker = message.talker()
        const [roomEntity] = await Promise.all([message.room()])

        // console.info('message:', message)
        // attachment handle
        const messageType = message.type()

        // console.info('on message ... ', message)


        const alias = await talker.alias()
        let showSender: string = alias ? `[${alias}] ${talker.name()}` : talker.name()

        // const topic = await roomEntity?.topic();
        const roomTopic = await roomEntity?.topic() || ''
        let bindItem = undefined
        if (roomEntity){
            bindItem = await this._tgClient.bindItemService.getBindItemByWechatId(roomEntity.id)
        }else {
            bindItem = await this._tgClient.bindItemService.getBindItemByWechatId(talker.id)
        }

        // todo: 优化
        // const mediaCaption=
        let identityStr = roomEntity ? `🌐${roomTopic} --- 👤${showSender} : ` : `👤${showSender} : `
        if (talker?.type() === PUPPET.types.Contact.Official) {
            identityStr = `📣${showSender} : `
        }
        const sendMessageBody: SimpleMessage = {
            sender: showSender,
            body: '收到一条 未知消息类型',
            room: roomTopic,
            type: talker?.type() === PUPPET.types.Contact.Official ? 1 : 0,
            id: message.id,
            chatId: bindItem ? bindItem.chat_id : this.tgClient.chatId
        }

        if (message.self()) {
            // 过滤掉自己所发送的消息
            if (this._tgClient.setting.getVariable(VariableType.SETTING_FORWARD_SELF)) {
                // 不转发文件
                if (messageType === PUPPET.types.Message.Attachment
                    || messageType === PUPPET.types.Message.Audio
                    || messageType === PUPPET.types.Message.Image
                    || messageType === PUPPET.types.Message.Video) {
                    return
                }
                let toSender = ''
                const to = message.listener()
                if (to) {
                    toSender = !to.payload?.alias ? `${to?.name()}` : `[${to.payload?.alias}] ${to?.name()}`
                } else {
                    toSender = message.room()?.payload?.topic ? `${message.room()?.payload?.topic}` : '未知群组'
                }
                identityStr = roomEntity ? `👤我->🌐${roomTopic}: ` : `👤我 -> 👤${toSender} : `
                const meTitle = `‍我 -> ${toSender}`
                sendMessageBody.sender = meTitle
                showSender = meTitle
            } else {
                return
            }
        }
        // 过滤公众号消息
        if (this._tgClient.setting.getVariable(VariableType.SETTING_ACCEPT_OFFICIAL_ACCOUNT) &&
            talker?.type() === PUPPET.types.Contact.Official) {
            return
        }

        // 添加用户至最近联系人
        let count = 0
        while (!talker.isReady() && count < 5) {
            talker.sync().catch(() => console.log('sync error'))
            count++
        }

        // 黑白名单过滤
        if (roomEntity) {
            const blackFind = this._tgClient.setting.getVariable(VariableType.SETTING_BLACK_LIST).find(item => item.name === roomTopic)
            const whiteFind = this._tgClient.setting.getVariable(VariableType.SETTING_WHITE_LIST).find(item => item.name === roomTopic)
            if (this._tgClient.setting.getVariable(VariableType.SETTING_NOTION_MODE) === NotionMode.BLACK) {
                if (blackFind) {
                    return
                }
            } else {
                if (!whiteFind && !await message.mentionSelf()) {
                    return
                }
            }
        }
        // 自动设置回复人
        const type = talker.type()
        if (!message.self() && !bindItem) {
            if (this._tgClient.setting && this._tgClient.setting.getVariable(VariableType.SETTING_AUTO_SWITCH) && type === PUPPET.types.Contact.Individual) {
                this._tgClient.setCurrentSelectContact(message)
            }

            // 设置最近联系人列表
            if (type === PUPPET.types.Contact.Individual) {
                const recentUsers = this._tgClient.recentUsers
                // 如果不存在该联系人
                const recentUser = recentUsers.find(item => (roomEntity && roomEntity.id) === item.talker?.id || (!roomEntity && talker.id === item.talker?.id))
                if (!recentUser) {
                    // 如果最近联系人数量大于5,则移除掉多余的联系人
                    if (recentUsers.length >= 5) {
                        recentUsers.pop()
                    }
                    const idInstance = UniqueIdGenerator.getInstance()
                    if (roomEntity) {
                        // 房间
                        recentUsers.unshift(new TalkerEntity('‍🌐' + roomTopic, 0, idInstance.generateId('recent'), roomEntity))
                    } else {
                        // 个人
                        recentUsers.unshift(new TalkerEntity('👤' + talker.name(), 1, idInstance.generateId('recent'), talker))
                    }
                } else {
                    // 找到元素在数组中的索引
                    const index = recentUsers.indexOf(recentUser)

                    // 如果元素存在于数组中
                    if (index !== -1) {
                        // 将元素从原索引位置删除
                        recentUsers.splice(index, 1)
                        // 将元素放在数组最前面
                        recentUsers.unshift(recentUser)
                    }
                }
            }
        }

        const sendMessageWhenNoAvatar = (name?: string) => {
            this._tgClient.sendMessage({
                sender: showSender,
                body: `收到一条 👤${name ? name : '未知'} 的名片消息,请在手机上查看`,
                type: talker?.type() === PUPPET.types.Contact.Official ? 1 : 0,
                room: roomTopic,
                id: message.id,
                chatId: bindItem ? bindItem.chat_id : this.tgClient.chatId
            })
        }

        switch (messageType) {
            case PUPPET.types.Message.Unknown:
                // console.log(talker.name(), ': 发送了unknown message...')

                if (message.text() === '收到红包，请在手机上查看') {
                    sendMessageBody.body = '收到红包，请在手机上查看'
                    this._tgClient.sendMessage(sendMessageBody)
                }
                if (message.text() === 'webwxvoipnotifymsg') {
                    sendMessageBody.body = '收到视频或语音通话,请在手机上处理'
                    this._tgClient.sendMessage(sendMessageBody)
                }
                break
            case PUPPET.types.Message.Text: {

                const messageTxt = message.text()

                if (messageTxt) {
                    // console.log('showSender is :', showSender, 'talker id is :', talker.id, 'message text is ', messageTxt,)
                    // 地址 只有个人发送的才会有这个连接的文本出现
                    if (messageTxt.endsWith('pictype=location')) {
                        const locationText = `位置信息: <code>${message.text().split('\n')[0].replace(':', '')}</code>`
                        this._tgClient.sendMessage({
                            sender: showSender,
                            body: locationText,
                            room: roomTopic,
                            type: talker?.type() === PUPPET.types.Contact.Official ? 1 : 0,
                            id: message.id,
                            not_escape_html: true,
                            chatId: bindItem ? bindItem.chat_id : this.tgClient.chatId
                        })
                        return
                    }
                    // 表情转换
                    const emojiConverter = new EmojiConverter()
                    const convertedText = emojiConverter.convert(messageTxt)
                    this._tgClient.sendMessage({
                        sender: showSender,
                        body: convertedText,
                        room: roomTopic,
                        type: talker?.type() === PUPPET.types.Contact.Official ? 1 : 0,
                        id: message.id,
                        chatId: bindItem ? bindItem.chat_id : this.tgClient.chatId
                    })
                }
            }
                break
            case PUPPET.types.Message.Contact:
                // 收到名片消息
                MessageUtils.messageTextToContact(message.text()).then(res => {
                    const shareContactCaption = `收到一条 👤${res.nickname} 的名片消息,请在手机上查看\n${identityStr}`
                    if (res.bigheadimgurl) {
                        FileBox.fromUrl(res.bigheadimgurl).toBuffer().then(avatarBuff => {
                            this._tgClient.bot.telegram.sendPhoto(
                                bindItem ? bindItem.chat_id : this.tgClient.chatId, {source: avatarBuff}, {caption: shareContactCaption}).then(msg => {
                                this._tgClient.saveMessage(msg.message_id, message.id)
                            }).catch(e=>{
                                if (e.response.error_code === 403){
                                    this.tgClient.bindItemService.removeBindItemByChatId(bindItem.chat_id)
                                    this._tgClient.bot.telegram.sendPhoto(
                                        this.tgClient.chatId, {source: avatarBuff}, {caption: shareContactCaption}).then(msg => {
                                        this._tgClient.saveMessage(msg.message_id, message.id)
                                    })
                                    return
                                }
                            })
                        }).catch(() => {
                            sendMessageWhenNoAvatar(res.nickname)
                        })
                    } else {
                        sendMessageWhenNoAvatar(res.nickname)
                    }
                }).catch(() => {
                    sendMessageWhenNoAvatar()
                })
                // console.log('contact message', message)
                break
            case PUPPET.types.Message.Attachment: {
                message.toFileBox().then(fBox => {
                    // 配置了tg api尝试发送大文件

                    if (this.sentMessageWhenFileToLage(fBox, {
                        sender: showSender,
                        body: '[文件]过大,请在微信上查收',
                        room: roomTopic,
                        type: talker?.type() === PUPPET.types.Contact.Official ? 1 : 0,
                        id: message.id,
                        chatId: bindItem ? bindItem.chat_id : this.tgClient.chatId
                    })) {
                        return
                    }
                    fBox.toBuffer().then(buff => {
                        // 配置了 tg api 尝试发送大文件
                        if (this.tgClient.tgClient) {
                            const customFile = new CustomFile(fBox.name, fBox.size, '', buff)
                            this.tgClient.tgClient.client.sendFile(this.tgClient.chatId, {
                                workers: 5,
                                file: customFile,
                                caption: identityStr,
                            }).catch((e) => {
                                console.error(e)
                                this._tgClient.sendMessage({
                                    sender: showSender,
                                    body: '[文件]转发失败，请在微信上查收',
                                    room: roomTopic,
                                    type: talker?.type() === PUPPET.types.Contact.Official ? 1 : 0,
                                    id: message.id,
                                    chatId: bindItem ? bindItem.chat_id : this.tgClient.chatId
                                })
                            })
                            return
                        }

                        // 语音文件 .sil直接重命名为mp3 可以直接播放
                        const fileName = fBox.name

                        const tgClient = this._tgClient
                        tgClient.bot.telegram.sendDocument(
                            bindItem ? bindItem.chat_id : this.tgClient.chatId, {source: buff, filename: fileName}, {
                                caption: identityStr
                            }).then(msg => {
                            this._tgClient.saveMessage(msg.message_id, message.id)
                        }).catch(e => {
                            if (e.response.error_code === 403){
                                this.tgClient.bindItemService.removeBindItemByChatId(bindItem.chat_id)
                                tgClient.bot.telegram.sendDocument(
                                    this.tgClient.chatId, {source: buff, filename: fileName}, {
                                        caption: identityStr
                                    }).then(msg => {
                                    this._tgClient.saveMessage(msg.message_id, message.id)
                                })
                                return
                            }
                            this._tgClient.sendMessage({
                                sender: showSender,
                                body: '[文件]转发失败，请在微信上查收',
                                room: roomTopic,
                                type: talker?.type() === PUPPET.types.Contact.Official ? 1 : 0,
                                id: message.id,
                                chatId: bindItem ? bindItem.chat_id : this.tgClient.chatId
                            })
                        })
                    })
                }).catch(() => {
                    this._tgClient.sendMessage({
                        sender: showSender,
                        body: `接收文件${message.payload?.filename}出错`,
                        type: talker?.type() === PUPPET.types.Contact.Official ? 1 : 0,
                        room: roomTopic,
                        id: message.id,
                        chatId: bindItem ? bindItem.chat_id : this.tgClient.chatId
                    })
                })
                break
            }
            case PUPPET.types.Message.Image: {
                message.toFileBox().then(fBox => {

                    if (this.sentMessageWhenFileToLage(fBox, {
                        sender: showSender,
                        body: '[图片]过大,请在微信上查收',
                        room: roomTopic,
                        type: talker?.type() === PUPPET.types.Contact.Official ? 1 : 0,
                        id: message.id,
                        chatId: bindItem ? bindItem.chat_id : this.tgClient.chatId
                    })) {
                        return
                    }
                    // 这里可以保存一份在本地 但是没有映射关系没法知道是谁的
                    fBox.toBuffer().then(buff => {

                        // 配置了 tg api 尝试发送大文件
                        if (this.tgClient.tgClient) {
                            const customFile = new CustomFile(fBox.name, fBox.size, '', buff)
                            this.tgClient.tgClient.client.sendFile(this.tgClient.chatId, {
                                workers: 5,
                                file: customFile,
                                caption: identityStr,
                            }).catch((e) => {
                                console.error(e)
                                this._tgClient.sendMessage({
                                    sender: showSender,
                                    body: '[图片]转发失败，请在微信上查收',
                                    room: roomTopic,
                                    type: talker?.type() === PUPPET.types.Contact.Official ? 1 : 0,
                                    id: message.id,
                                    chatId: bindItem ? bindItem.chat_id : this.tgClient.chatId
                                })
                            })
                            return
                        }
                        const fileName = fBox.name

                        const tgClient = this._tgClient
                        if (this._tgClient.setting.getVariable(VariableType.SETTING_COMPRESSION)) {
                            tgClient.bot.telegram.sendPhoto(
                                bindItem ? bindItem.chat_id : this.tgClient.chatId, {
                                    source: buff,
                                    filename: fileName
                                }, {caption: identityStr}).then(msg => {
                                this._tgClient.saveMessage(msg.message_id, message.id)
                            }).catch(e => {
                                if (e.response.error_code === 403){
                                    this.tgClient.bindItemService.removeBindItemByChatId(bindItem.chat_id)
                                    tgClient.bot.telegram.sendPhoto(
                                        this.tgClient.chatId, {
                                            source: buff,
                                            filename: fileName
                                        }, {caption: identityStr}).then(msg => {
                                        this._tgClient.saveMessage(msg.message_id, message.id)
                                    })
                                    return
                                }
                                this._tgClient.sendMessage({
                                    sender: showSender,
                                    body: '[图片]文件转发失败，请在微信上查收',
                                    room: roomTopic,
                                    type: talker?.type() === PUPPET.types.Contact.Official ? 1 : 0,
                                    id: message.id,
                                    chatId: bindItem ? bindItem.chat_id : this.tgClient.chatId
                                })
                            })
                        } else {
                            tgClient.bot.telegram.sendDocument(
                                bindItem ? bindItem.chat_id : this.tgClient.chatId, {
                                    source: buff,
                                    filename: fileName
                                }, {caption: identityStr}).then(msg => {
                                this._tgClient.saveMessage(msg.message_id, message.id)
                            }).catch(e => {
                                if (e.response.error_code === 403){
                                    this.tgClient.bindItemService.removeBindItemByChatId(bindItem.chat_id)
                                    tgClient.bot.telegram.sendDocument(
                                        this.tgClient.chatId, {
                                            source: buff,
                                            filename: fileName
                                        }, {caption: identityStr}).then(msg => {
                                        this._tgClient.saveMessage(msg.message_id, message.id)
                                    })
                                    return
                                }
                                this._tgClient.sendMessage({
                                    sender: showSender,
                                    body: '[图片]文件转发失败，请在微信上查收',
                                    room: roomTopic,
                                    type: talker?.type() === PUPPET.types.Contact.Official ? 1 : 0,
                                    id: message.id,
                                    chatId: bindItem ? bindItem.chat_id : this.tgClient.chatId
                                })
                            })
                        }
                    })
                })
                break
            }
            case PUPPET.types.Message.Audio: {
                message.toFileBox().then(fBox => {
                    // 这里可以保存一份在本地 但是没有映射关系没法知道是谁的
                    fBox.toBuffer().then(buff => {
                        if (this.sentMessageWhenFileToLage(fBox, {
                            sender: showSender,
                            body: '[语音]过大,请在微信上查收',
                            room: roomTopic,
                            type: talker?.type() === PUPPET.types.Contact.Official ? 1 : 0,
                            id: message.id,
                            chatId: bindItem ? bindItem.chat_id : this.tgClient.chatId
                        })) {
                            return
                        }
                        let fileName = fBox.name
                        const tgClient = this._tgClient
                        tgClient.bot.telegram.sendVoice(
                            bindItem ? bindItem.chat_id : this.tgClient.chatId, {source: buff, filename: fileName}, {caption: identityStr}).then(msg => {
                            this._tgClient.saveMessage(msg.message_id, message.id)
                        }).catch(res => {
                            if (res.response.error_code === 403){
                                this.tgClient.bindItemService.removeBindItemByChatId(bindItem.chat_id)
                                if (fileName.endsWith('.sil')) {
                                    fileName = fileName.replace('.sil', '.mp3')
                                }
                                // 如果用户不接收语音则发送文件
                                tgClient.bot.telegram.sendDocument(this.tgClient.chatId, {
                                    source: buff,
                                    filename: fileName
                                }, {caption: identityStr}).then(msg => {
                                    this._tgClient.saveMessage(msg.message_id, message.id)
                                })
                                return
                            }
                            if (fileName.endsWith('.sil')) {
                                fileName = fileName.replace('.sil', '.mp3')
                            }
                            // 如果用户不接收语音则发送文件
                            tgClient.bot.telegram.sendDocument(bindItem ? bindItem.chat_id : this.tgClient.chatId, {
                                source: buff,
                                filename: fileName
                            }, {caption: identityStr}).then(msg => {
                                this._tgClient.saveMessage(msg.message_id, message.id)
                            }).catch(e => {
                                if (e.response.error_code === 403){
                                    this.tgClient.bindItemService.removeBindItemByChatId(bindItem.chat_id)
                                    tgClient.bot.telegram.sendDocument(this.tgClient.chatId, {
                                        source: buff,
                                        filename: fileName
                                    }, {caption: identityStr}).then(msg => {
                                        this._tgClient.saveMessage(msg.message_id, message.id)
                                    })
                                    return
                                }
                                this._tgClient.sendMessage({
                                    sender: showSender,
                                    body: '[语音]文件转发失败,请在微信上查收',
                                    room: roomTopic,
                                    type: talker?.type() === PUPPET.types.Contact.Official ? 1 : 0,
                                    id: message.id,
                                    chatId: bindItem ? bindItem.chat_id : this.tgClient.chatId
                                })
                            })
                        })
                    })
                })
                break
            }
            case PUPPET.types.Message.Video: {
                message.toFileBox().then(fBox => {
                    // 这里可以保存一份在本地 但是没有映射关系没法知道是谁的
                    fBox.toBuffer().then(buff => {

                        // 配置了 tg api 尝试发送大文件
                        if (this.tgClient.tgClient) {
                            const customFile = new CustomFile(fBox.name, fBox.size, '', buff)
                            this.tgClient.tgClient.client.sendFile(this.tgClient.chatId, {
                                workers: 5,
                                file: customFile,
                                caption: identityStr,
                            }).catch((e) => {
                                console.error(e)
                                this._tgClient.sendMessage({
                                    sender: showSender,
                                    body: '[视频]转发失败，请在微信上查收',
                                    room: roomTopic,
                                    type: talker?.type() === PUPPET.types.Contact.Official ? 1 : 0,
                                    id: message.id,
                                    chatId: bindItem ? bindItem.chat_id : this.tgClient.chatId
                                })
                            })
                            return
                        }
                        const fileName = fBox.name

                        if (this.sentMessageWhenFileToLage(fBox, {
                            sender: showSender,
                            body: '[视频]过大,请在微信上查收',
                            room: roomTopic,
                            type: talker?.type() === PUPPET.types.Contact.Official ? 1 : 0,
                            id: message.id,
                            chatId: bindItem ? bindItem.chat_id : this.tgClient.chatId
                        })) {
                            return
                        }

                        const tgClient = this._tgClient
                        if (this._tgClient.setting.getVariable(VariableType.SETTING_COMPRESSION)) {
                            tgClient.bot.telegram.sendVideo(
                                bindItem ? bindItem.chat_id : this.tgClient.chatId, {
                                    source: buff,
                                    filename: fileName
                                }, {caption: identityStr}).then(msg => {
                                this._tgClient.saveMessage(msg.message_id, message.id)
                            }).catch(e => {
                                if (e.response.error_code === 403){
                                    this.tgClient.bindItemService.removeBindItemByChatId(bindItem.chat_id)
                                    tgClient.bot.telegram.sendVideo(
                                        this.tgClient.chatId, {
                                            source: buff,
                                            filename: fileName
                                        }, {caption: identityStr}).then(msg => {
                                        this._tgClient.saveMessage(msg.message_id, message.id)
                                    })
                                    return
                                }
                                this._tgClient.sendMessage({
                                    sender: showSender,
                                    body: '[视频]文件转发失败,请在微信上查收',
                                    room: roomTopic,
                                    type: talker?.type() === PUPPET.types.Contact.Official ? 1 : 0,
                                    id: message.id,
                                    chatId: bindItem ? bindItem.chat_id : this.tgClient.chatId
                                })
                            })
                        } else {
                            tgClient.bot.telegram.sendDocument(
                                bindItem ? bindItem.chat_id : this.tgClient.chatId, {
                                    source: buff,
                                    filename: fileName
                                }, {caption: identityStr}).then(msg => {
                                this._tgClient.saveMessage(msg.message_id, message.id)
                            }).catch(e => {
                                if (e.response.error_code === 403){
                                    this.tgClient.bindItemService.removeBindItemByChatId(bindItem.chat_id)
                                    tgClient.bot.telegram.sendDocument(
                                        this.tgClient.chatId, {
                                            source: buff,
                                            filename: fileName
                                        }, {caption: identityStr}).then(msg => {
                                        this._tgClient.saveMessage(msg.message_id, message.id)
                                    })
                                    return
                                }
                                this._tgClient.sendMessage({
                                    sender: showSender,
                                    body: '[视频]文件转发失败,请在微信上查收',
                                    room: roomTopic,
                                    type: talker?.type() === PUPPET.types.Contact.Official ? 1 : 0,
                                    id: message.id,
                                    chatId: bindItem ? bindItem.chat_id : this.tgClient.chatId
                                })
                            })
                        }
                    })
                })
                break
            }
            case PUPPET.types.Message.Emoticon: // 处理表情消息的逻辑
                this._tgClient.sendMessage({
                    sender: showSender,
                    type: talker?.type() === PUPPET.types.Contact.Official ? 1 : 0,
                    body: '[动画表情]',
                    room: roomTopic,
                    id: message.id,
                    chatId: bindItem ? bindItem.chat_id : this.tgClient.chatId
                })
                break
            case PUPPET.types.Message.MiniProgram: // 处理小程序消息的逻辑
                sendMessageBody.body = '收到一条小程序消息'
                this._tgClient.sendMessage(sendMessageBody)
                break
            case PUPPET.types.Message.RedEnvelope: // 处理红包消息的逻辑 12
                break
            case PUPPET.types.Message.Url: // 处理链接消息的逻辑
                message.toUrlLink().then(url => {
                    sendMessageBody.body = `链接消息：${url.description()} <a href="${url.url()}">${url.title()}</a>`
                    this._tgClient.sendMessage({...sendMessageBody, not_escape_html: true})
                })
                break
            case PUPPET.types.Message.Transfer: // 处理转账消息的逻辑 11
                sendMessageBody.body = '收到一条转账消息'
                this._tgClient.sendMessage(sendMessageBody)
                break
            case PUPPET.types.Message.Recalled: // 处理撤回消息的逻辑
                sendMessageBody.body = '撤回了一条消息'
                this._tgClient.sendMessage(sendMessageBody)
                break
            case PUPPET.types.Message.GroupNote:
                // 处理群公告消息的逻辑
                break
            case PUPPET.types.Message.ChatHistory:  // ChatHistory(19)
                break
            case PUPPET.types.Message.Post: // 处理帖子消息的逻辑
                // sendMessageBody.body = `收到一条暂不支持的消息类型: ${messageType}`
                // this._tgClient.sendMessage(sendMessageBody)
                break
            case PUPPET.types.Message.Location: // 处理位置消息的逻辑
                break
            default:
                break
        }


        // 发现好像不需要缓存头像而且每次重新登陆返回的id不同
        // const avatarPath = `avatar/${talker.id}`
        // if (!fs.existsSync(avatarPath)) {
        //     fs.mkdirSync(avatarPath, {recursive: true});
        // }
        // talker.avatar().then(fb => fb.toFile(avatarPath + '/avatar.jpg', true))

    }

    private async cacheMember() {
        const contactList = await this._client.Contact.findAll()
        // 不知道是什么很多空的 过滤掉没名字和不是朋友的
        const filter = contactList.filter(it => it.name() && it.friend())
        await contactList.forEach(async item => {
            let count = 0
            while (item.payload?.alias === item.name() && count < 5) {
                await item.sync()
                count++
            }
        })
        filter.forEach(it => {
            const type = it.type()
            const id = UniqueIdGenerator.getInstance().generateId('contact')
            switch (type) {
                case ContactImpl.Type.Unknown:
                    this.contactMap?.get(ContactImpl.Type.Unknown)?.add({id:id,contact:it})
                    break
                case ContactImpl.Type.Individual:
                    this.contactMap?.get(ContactImpl.Type.Individual)?.add({id:id,contact:it})
                    break
                case ContactImpl.Type.Official:
                    this.contactMap?.get(ContactImpl.Type.Official)?.add({id:id,contact:it})
                    break
                case ContactImpl.Type.Corporation:
                    this.contactMap?.get(ContactImpl.Type.Corporation)?.add({id:id,contact:it})
                    break
            }
        })

        // 缓存到客户端的实例
        // 一起获取群放到缓存
        const room = await this._client.Room.findAll()
        await room.forEach(async it => {
            const l = await it.memberAll()
            if (l.length > 0) {
                const id = UniqueIdGenerator.getInstance().generateId('room')
                this._roomList.push({room:it,id:id})
            }
        })
        this.tgClient.bindItemService.updateItem(this.roomList,this.contactMap)
    }

    private resetValue() {
        const filePath = 'storage/wechat_bot.memory-card.json'
        fs.access(filePath, fs.constants.F_OK, (err) => {
            if (!err) {
                // 文件存在，删除文件
                fs.unlink(filePath, (err) => {
                    if (err) {
                        console.error('Error deleting file:', err)
                    } else {
                        console.log('File deleted successfully')
                    }
                    this.contactMap?.get(ContactImpl.Type.Individual)?.clear()
                    this.contactMap?.get(ContactImpl.Type.Official)?.clear()
                    this.cacheMemberDone = false
                    this.cacheMemberSendMessage = false
                    this._roomList = []
                    this.tgClient.selectedMember = []
                    this.tgClient.flagPinMessageType = ''
                    this.tgClient.findPinMessage()
                    this.tgClient.reset()
                })
            }
        })
    }

    private sentMessageWhenFileToLage(fileBox: FileBoxInterface, message: SimpleMessage): boolean {
        // 配置了tg api可以往下走发送
        if (!this.tgClient.tgClient && fileBox.size > 1024 * 1024 * 50) {
            this._tgClient.sendMessage(message)
            return true
        }
        return false
    }
}