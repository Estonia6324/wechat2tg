import {Context, Markup, NarrowedContext, Telegraf} from 'telegraf';
import {WeChatClient} from "./WechatClient";
import {config} from "../config";
import {BotHelpText, SimpleMessage, SimpleMessageSender} from "../models/Message"
import {SocksProxyAgent} from 'socks-proxy-agent'
import {HttpsProxyAgent} from "https-proxy-agent";
import * as tg from "telegraf/src/core/types/typegram";
import {message} from "telegraf/filters";
import {FileBox} from 'file-box'
import * as fs from "node:fs";
import {NotionListType, NotionMode, StorageSettings, VariableContainer, VariableType} from "../models/Settings";
import {ConverterHelper} from "../utils/FfmpegUtils";
import {MemberCacheType, SelectedEntity} from "../models/TgCache";
import {TalkerEntity} from "../models/TalkerCache";
import {UniqueIdGenerator} from "../utils/IdUtils";
import {Page} from "../models/Page";
import {FileUtils} from "../utils/FileUtils";
import {ContactImpl, ContactInterface, MessageInterface, RoomInterface} from "wechaty/impls";
import {CacheHelper} from "../utils/CacheHelper";
import * as PUPPET from "wechaty-puppet";
import * as timers from "node:timers";

export class TelegramClient {
    get flagPinMessageType(): string {
        return this._flagPinMessageType;
    }

    set flagPinMessageType(value: string) {
        this._flagPinMessageType = value;
    }

    get selectedMember(): SelectedEntity[] {
        return this._selectedMember;
    }

    set selectedMember(value: SelectedEntity[]) {
        this._selectedMember = value;
    }

    get recentUsers(): TalkerEntity[] {
        return this._recentUsers;
    }

    private _weChatClient: WeChatClient;
    private readonly _bot: Telegraf;
    private _chatId: number | string;
    private _ownerId: number;
    private loginCommandExecuted = false;
    private static PAGE_SIZE = 18;
    private static LINES = 2;
    private _selectedMember: SelectedEntity [] = [];
    private _flagPinMessageType = '';
    private calcShowMemberListExecuted = false;
    private selectRoom: ContactInterface | RoomInterface | undefined;
    private _recentUsers: TalkerEntity [] = [];
    private wechatStartFlag = false;
    private searchList: any[] = []

    private forwardSetting: VariableContainer = new VariableContainer();

    // key this message id value weChat message id
    private _messageMap = new Map<number, string>();
    // 当前回复用户
    private _currentSelectContact: ContactInterface | RoomInterface | undefined;
    // 置顶消息
    private pinnedMessageId: number | undefined


    constructor() {
        this._weChatClient = new WeChatClient(this);
        this._bot = new Telegraf(config.BOT_TOKEN)
        this._chatId = 0;
        this._ownerId = 0;
        this._chatId = 0
        if (config.PROTOCOL === 'socks5' && config.HOST !== '' && config.PORT !== '') {
            const info = {
                hostname: config.HOST,
                port: config.PORT,
                username: config.USERNAME,
                password: config.PASSWORD
            }

            const socksAgent = new SocksProxyAgent(info)
            this._bot = new Telegraf(config.BOT_TOKEN, {
                telegram: {
                    agent: socksAgent
                }
            })
        } else if ((config.PROTOCOL === 'http' || config.PROTOCOL === 'https') && config.HOST !== '' && config.PORT !== '') {
            const httpAgent = new HttpsProxyAgent(`${config.PROTOCOL}://${config.USERNAME}:${config.PASSWORD}@${config.HOST}:${config.PORT}`)
            this._bot = new Telegraf(config.BOT_TOKEN, {
                telegram: {
                    agent: httpAgent
                }
            })
        } else {
            this._bot = new Telegraf(config.BOT_TOKEN)
        }
        // this._messageMap
        this.onWeChatLogout = this.onWeChatLogout.bind(this);
        this.onWeChatStop = this.onWeChatStop.bind(this);
    }

    public get messageMap(): Map<number, string> {
        return this._messageMap;
    }

    public set messageMap(value: Map<number, string>) {
        this._messageMap = value;
    }

    public get bot(): Telegraf {
        return this._bot;
    }

    public get setting(): VariableContainer {
        return this.forwardSetting;
    }

    public get chatId(): number | string {
        return this._chatId;
    }

    public get currentSelectContact(): ContactInterface | RoomInterface | undefined {
        return this._currentSelectContact;
    }

    public async setCurrentSelectContact(value: MessageInterface | undefined) {
        if (value) {
            const room = value.room()
            if (room) {
                this.setPin('room', await room.topic())
                this.selectRoom = room
            } else {
                this._currentSelectContact = value.talker();
                const talker = value.talker()
                const alias = await talker.alias()
                if (alias) {
                    this.setPin('user', alias)
                } else {
                    this.setPin('user', talker.name())
                }
            }
        }
    }

    public get weChatClient(): WeChatClient {
        return this._weChatClient;
    }

    // Setter 方法
    public set weChatClient(value: WeChatClient) {
        this._weChatClient = value;
    }


    public init() {
        const bot = this._bot;

        // 加载转发配置
        this.loadForwardSettings();

        // 初始化配置
        this.forwardSetting.writeToFile()
        this.loadForwardSettings();

        // Enable graceful stop
        // process.once('SIGINT', () => bot.stop('SIGINT'))
        // process.once('SIGTERM', () => bot.stop('SIGTERM'))

        bot.telegram.setMyCommands([
            {command: 'help', description: '使用说明'},
            {command: 'start', description: '开始'},
            {command: 'login', description: '扫码登陆'},
            {command: 'user', description: '用户列表'},
            {command: 'room', description: '群组列表'},
            {command: 'recent', description: '最近联系人'},
            {command: 'settings', description: '程序设置'},
            {command: 'check', description: '微信登录状态'},
            {command: 'reset', description: '清空缓存重新登陆'},
            {command: 'stop', description: '停止微信客户端,需要重新登陆'},
            // {command: 'logout', description: '退出登陆'},
            // {command: 'stop', description: '停止微信客户端'},
            // {command: 'quit', description: '退出程序!! 会停止程序,需要手动重启(未实现)'},
        ]);

        bot.use((ctx, next) => {
            if (!this._chatId) {
                return next()
            }

            if (ctx.chat && this._chatId === ctx.chat.id) {
                return next(); // 如果用户授权，则继续处理下一个中间件或命令
            }
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            // help 命令 start 命令
            if (ctx.message['text'] === '/start' || ctx.message['text'] === '/help') {
                return next();
            } else {
                return ctx.reply('Sorry, you are not authorized to interact with this bot.'); // 如果用户未授权，发送提示消息
            }
        });

        bot.help((ctx) => ctx.replyWithMarkdownV2(BotHelpText.help))

        bot.start(async ctx => {
            ctx.reply(
                '请输入 /login 登陆,或者输入 /help 查看帮助\n' +
                '请注意执行/login 后你就是该机器的所有者'
                , Markup.removeKeyboard())
        })

        // 重启时判断是否有主人,如果存在主人则自动登录微信
        const variables = this.forwardSetting.getAllVariables()
        if (variables.chat_id && variables.chat_id !== '') {
            this._chatId = variables.chat_id
            // this._bot.telegram.sendMessage(this._chatId, `程序开始初始化...`)
            // 找到置顶消息
            this.findPinMessage();
            if (!this.wechatStartFlag) {
                this.wechatStartFlag = true
                this._weChatClient.start().then(() => {

                    // 标记为已执行
                    this.loginCommandExecuted = true;


                    console.log("自动启动微信bot")
                }).catch(() => {
                    console.error("自动启动失败");
                });
            }
        }

        bot.settings(ctx => {

            ctx.reply('程序设置:', {
                reply_markup: this.getSettingButton()
            })
        });

        // 好友请求处理
        bot.action(/friendship-accept/, async ctx => {
            console.log('接受到 好友请求', ctx.match.input)
            const friend = this._weChatClient.friendShipList.find(item => item.id === ctx.match.input)?.friendship
            if (!friend) {
                ctx.deleteMessage().then(() => ctx.reply("好友申请已过期!"))
                ctx.answerCbQuery()
                return
            } else {
                await friend.accept()
                ctx.deleteMessage().then(() => ctx.reply("添加成功!"))
            }
            ctx.answerCbQuery()
        })

        // 通知模式
        bot.action(VariableType.SETTING_NOTION_MODE, ctx => {
            // 黑名单
            if (this.forwardSetting.getVariable(VariableType.SETTING_NOTION_MODE) === NotionMode.BLACK) {
                this.forwardSetting.setVariable(VariableType.SETTING_NOTION_MODE, NotionMode.WHITE)
            } else {
                this.forwardSetting.setVariable(VariableType.SETTING_NOTION_MODE, NotionMode.BLACK)
            }
            // 点击后修改上面按钮
            ctx.editMessageReplyMarkup(this.getSettingButton());

            // 点击后持久化
            this.forwardSetting.writeToFile()
            ctx.answerCbQuery()
        })

        // 修改回复设置
        bot.action(VariableType.SETTING_REPLY_SUCCESS, ctx => {
            const b = !this.forwardSetting.getVariable(VariableType.SETTING_REPLY_SUCCESS);
            const answerText = b ? '开启' : '关闭';
            this.forwardSetting.setVariable(VariableType.SETTING_REPLY_SUCCESS, b)
            // 修改后持成文件
            this.forwardSetting.writeToFile()
            // 点击后修改上面按钮
            ctx.editMessageReplyMarkup(this.getSettingButton());

            return ctx.answerCbQuery(answerText)
        });

        // 自动切换设置
        bot.action(VariableType.SETTING_AUTO_SWITCH, ctx => {
            const b = !this.forwardSetting.getVariable(VariableType.SETTING_AUTO_SWITCH);
            const answerText = b ? '开启' : '关闭';
            this.forwardSetting.setVariable(VariableType.SETTING_AUTO_SWITCH, b)
            // 修改后持成文件
            this.forwardSetting.writeToFile()
            // 点击后修改上面按钮
            ctx.editMessageReplyMarkup(this.getSettingButton());
            return ctx.answerCbQuery(answerText)
        });

        // 接受公众号消息
        bot.action(VariableType.SETTING_ACCEPT_OFFICIAL_ACCOUNT, ctx => {
            const b = !this.forwardSetting.getVariable(VariableType.SETTING_ACCEPT_OFFICIAL_ACCOUNT);
            const answerText = b ? '关闭' : '开启';
            this.forwardSetting.setVariable(VariableType.SETTING_ACCEPT_OFFICIAL_ACCOUNT, b)
            // 修改后持成文件
            this.forwardSetting.writeToFile()
            // 点击后修改上面按钮
            ctx.editMessageReplyMarkup(this.getSettingButton());
            return ctx.answerCbQuery(answerText)
        })

        // 接受公众号消息
        bot.action(VariableType.SETTING_FORWARD_SELF, ctx => {
            const b = !this.forwardSetting.getVariable(VariableType.SETTING_FORWARD_SELF);
            const answerText = b ? '开启' : '关闭';
            this.forwardSetting.setVariable(VariableType.SETTING_FORWARD_SELF, b)
            // 修改后持成文件
            this.forwardSetting.writeToFile()
            // 点击后修改上面按钮
            ctx.editMessageReplyMarkup(this.getSettingButton());
            return ctx.answerCbQuery(answerText)
        })

        // 媒体质量压缩
        bot.action(VariableType.SETTING_COMPRESSION, ctx => {
            const b = !this.forwardSetting.getVariable(VariableType.SETTING_COMPRESSION);
            const answerText = b ? '开启' : '关闭';
            this.forwardSetting.setVariable(VariableType.SETTING_COMPRESSION, b)
            // 修改后持成文件
            this.forwardSetting.writeToFile()
            // 点击后修改上面按钮
            ctx.editMessageReplyMarkup(this.getSettingButton());
            return ctx.answerCbQuery(answerText)
        })

        // 白名单设置
        bot.action(VariableType.SETTING_WHITE_LIST, ctx => {
            // 当前白名单
            ctx.reply('白名单管理:', Markup.inlineKeyboard([
                [Markup.button.callback(`添加白名单`, 'listAdd-')],
                [Markup.button.callback(`白名单列表`, 'whiteList-1')]
            ]))
            ctx.answerCbQuery()
        });

        // 白名单列表
        bot.action(/whiteList-(\d+)/, ctx => {
            const pageNum = parseInt(ctx.match[1]);
            // 获取黑名单或者白名单的列表
            const list = this.forwardSetting.getVariable(VariableType.SETTING_WHITE_LIST)
            if (!list || list.length === 0) {
                ctx.reply("白名单列表为空")
                ctx.answerCbQuery()
                return
            }
            const page = new Page(list, pageNum, 5)
            const buttons = []
            const pageList = page.getList(pageNum)
            for (const pageListElement of pageList) {
                buttons.push([Markup.button.callback(`🌐${pageListElement.name}`, `whiteListRemove-${pageListElement.id}`)])
            }
            buttons.push([Markup.button.callback('上一页', `whiteList-${pageNum - 1}`, !page.hasLast()), Markup.button.callback('下一页', `whiteList-${pageNum + 1}`, !page.hasNext())])
            ctx.editMessageText('白名单列表(点击移除):', Markup.inlineKeyboard(buttons))
            ctx.answerCbQuery()
        })

        // 白名单移除
        bot.action(/whiteListRemove-(\d+)/, ctx => {
            const id = parseInt(ctx.match[1]);
            // 获取黑名单或者白名单的列表
            const list = this.forwardSetting.getVariable(VariableType.SETTING_WHITE_LIST)
            this.forwardSetting.setVariable(VariableType.SETTING_WHITE_LIST, list.filter(item => {
                return item.id !== id + ''
            }))
            this.forwardSetting.writeToFile()
            ctx.deleteMessage().then(() => {
                ctx.answerCbQuery('移除成功')
            })
        })

        // 黑名单设置
        bot.action(VariableType.SETTING_BLACK_LIST, ctx => {
            // 当前黑名单
            ctx.reply('黑名单管理:', Markup.inlineKeyboard([
                [Markup.button.callback(`添加黑名单`, 'listAdd-')],
                [Markup.button.callback(`黑名单列表`, 'blackList-1')]
            ]))
            ctx.answerCbQuery()
        });

        // 黑名单列表
        bot.action(/blackList-(\d+)/, ctx => {
            const pageNum = parseInt(ctx.match[1]);
            // 获取黑名单或者白名单的列表
            const list = this.forwardSetting.getVariable(VariableType.SETTING_BLACK_LIST)
            if (!list || list.length === 0) {
                ctx.reply("黑名单列表为空")
                ctx.answerCbQuery()
                return
            }
            const page = new Page(list, pageNum, 5)
            const buttons = []
            const pageList = page.getList(pageNum)
            for (const pageListElement of pageList) {
                buttons.push([Markup.button.callback(`🌐${pageListElement.name}`, `blackListRemove-${pageListElement.id}`)])
            }
            buttons.push([Markup.button.callback('上一页', `blackList-${pageNum - 1}`, !page.hasLast()), Markup.button.callback('下一页', `blackList-${pageNum + 1}`, !page.hasNext())])
            ctx.editMessageText('黑名单列表(点击移除):', Markup.inlineKeyboard(buttons))
            ctx.answerCbQuery()
        })

        // 黑名单移除
        bot.action(/blackListRemove-(\d+)/, ctx => {
            const id = parseInt(ctx.match[1]);
            // 获取黑名单或者白名单的列表
            const list = this.forwardSetting.getVariable(VariableType.SETTING_BLACK_LIST)
            this.forwardSetting.setVariable(VariableType.SETTING_BLACK_LIST, list.filter(item => {
                return item.id !== id + ''
            }))
            this.forwardSetting.writeToFile()
            ctx.deleteMessage().then(() => {
                ctx.answerCbQuery("移除成功")
            })
        })

        let listAdd = false;

        // 黑白名单添加
        bot.action(/listAdd-/, ctx => {
            ctx.reply('输入要加入名单的群名').then(() => {
                listAdd = true
            })
            ctx.answerCbQuery()
        })


        bot.command('reset', (ctx) => {
            this._weChatClient.reset()
            ctx.reply('重置成功')
        })


        // bot.command('restart', (ctx) => {
        //     this._weChatClient.logout()
        //     ctx.reply('重启中...')
        // })

        bot.command('login', async ctx => {
            if (!this.wechatStartFlag) {
                this.wechatStartFlag = true
                this._weChatClient.start().then(() => {


                    // 第一次输入的人当成bot的所有者
                    this.loadOwnerChat(ctx);

                    // 标记为已执行
                    this.loginCommandExecuted = true;

                }).catch(() => {
                    ctx.reply('已经登陆或登陆失败请检查状态');
                });
            }

        });

        // bot.command('logout', this.onWeChatLogout)

        bot.command('stop', this.onWeChatStop)

        bot.command('check', ctx => {
            if (this.wechatStartFlag && this._weChatClient.client.isLoggedIn) {
                ctx.reply('微信在线')
            } else {
                ctx.reply('微信不在线')
            }
        })
        // 选择群聊
        const currentSelectRoomMap = new Map<string, RoomInterface>();
        let searchRooms: RoomInterface [] = [];

        bot.command('room', async ctx => {

            if (!this._weChatClient.cacheMemberDone) {
                ctx.reply('正在加载联系人列表,现在返回的数据可能不完整')
            }

            // 获取消息文本
            const messageText = ctx.update.message.text;

            // 正则表达式用来分离命令后面的参数
            const match = messageText.match(/\/room\s+([\p{L}\p{N}_]+)/u);
            if (match) {
                const topic = match[1];  // 提取用户名
                const filterRoom = this._weChatClient.roomList.filter(room => {
                    // const roomName = ;
                    return room.payload?.topic?.includes(topic)
                })
                if (filterRoom && filterRoom.length > 0) {
                    const buttons: tg.InlineKeyboardButton[][] = [];
                    await filterRoom.forEach(async item => {
                        const id = UniqueIdGenerator.getInstance().generateId("search")
                        this.searchList.push({
                            id: id,
                            contact: item,
                            type: 1
                        })
                        buttons.push([Markup.button.callback(`🌐${await item.topic()}`, `${id}`)])
                    })
                    ctx.reply("请选择联系人(点击回复):", Markup.inlineKeyboard(buttons))
                } else {
                    ctx.reply("未找到该群组:" + topic)
                }
                return
            }

            // const topic = ctx.message.text.split(' ')[1];
            // // 缓存加载
            // const filterRoom = this._weChatClient.roomList.filter(room => {
            //     // const roomName = ;
            //     return room.payload?.topic?.includes(topic)
            // })

            const count = 0;
            searchRooms = this._weChatClient.roomList;
            this.generateRoomButtons(searchRooms, currentSelectRoomMap, count).then(buttons => {
                if (buttons.length === 0) {
                    ctx.reply('没有找到群聊')
                } else {
                    ctx.reply('请选择群聊(点击回复):', {
                        ...Markup.inlineKeyboard(buttons)
                    })
                }
            })
        })

        bot.action(/room-index-\d+/, async (ctx) => {
            // console.log(ctx.match.input)
            const room = currentSelectRoomMap.get(ctx.match.input)
            this.selectRoom = room;

            this.setPin('room', await room?.topic())
            ctx.answerCbQuery()
        })

        bot.action(/room-next-\d+/, async (ctx) => {
            const nextPage = parseInt(ctx.match.input.slice(10));
            this.generateRoomButtons(searchRooms, currentSelectRoomMap, nextPage).then(buttons => {
                ctx.editMessageReplyMarkup({
                    inline_keyboard: buttons
                })
            })
            await ctx.answerCbQuery()
        })

        // let contactMap = this._weChatClient.contactMap;

        let currentSearchWord = '';

        bot.command('user', async ctx => {

            // wait all contact loaded
            if (!this._weChatClient.client.isLoggedIn) {
                ctx.reply('请先登陆并获取用户列表');
                return;
            }

            if (!this.loginCommandExecuted) {
                await ctx.reply('请等待,正在登陆...');
                return;
            }

            if (!this._weChatClient.cacheMemberDone) {
                ctx.reply('正在加载联系人列表,现在返回的数据可能不完整')
            }

            // 获取消息文本
            const messageText = ctx.update.message.text;

            // 正则表达式用来分离命令后面的参数
            const match = messageText.match(/\/user\s+([\p{L}\p{N}_]+)/u);
            if (match) {
                const username = match[1];  // 提取用户名
                const individual = this._weChatClient.contactMap?.get(ContactImpl.Type.Individual);
                const official = this._weChatClient.contactMap?.get(ContactImpl.Type.Official);
                const individualFilter: ContactInterface[] = []
                individual?.forEach(item => {
                    const alias = item.payload?.alias
                    if (alias?.includes(username)) {
                        individualFilter.push(item)
                        return
                    }
                    if (item.name().includes(username)) {
                        individualFilter.push(item)
                    }
                })
                const officialFilter: ContactInterface[] = []
                official?.forEach(item => {
                    const alias = item.payload?.alias
                    if (alias?.includes(username)) {
                        officialFilter.push(item)
                        return
                    }
                    if (item.name().includes(username)) {
                        officialFilter.push(item)
                    }
                })
                if ((individualFilter && individualFilter.length > 0) || (officialFilter && officialFilter.length > 0)) {
                    const buttons: tg.InlineKeyboardButton[][] = [];
                    [...officialFilter, ...individualFilter].forEach(item => {
                        const id = UniqueIdGenerator.getInstance().generateId("search")
                        this.searchList.push({
                            id: id,
                            contact: item,
                            type: 0
                        })
                        if (item.payload?.type === PUPPET.types.Contact.Official) {
                            buttons.push([Markup.button.callback(`📣${item.name()}`, `${id}`)])
                        } else {
                            if (item.payload?.alias) {
                                buttons.push([Markup.button.callback(`👤${item.payload?.alias}[${item.name()}]`, `${id}`)])
                            } else {
                                buttons.push([Markup.button.callback(`👤${item.name()}`, `${id}`)])
                            }
                        }
                    })
                    ctx.reply("请选择联系人(点击回复):", Markup.inlineKeyboard(buttons))
                } else {
                    ctx.reply("未找到该用户:" + username)
                }
                return
            }

            if (ctx.message.text) {
                currentSearchWord = ctx.message.text.split(' ')[1];
            } else {
                currentSearchWord = ''
            }


            // Create inline keyboard
            const inlineKeyboard = Markup.inlineKeyboard([
                // Markup.button.callback('未知', 'UNKNOWN'),
                Markup.button.callback('个人', 'INDIVIDUAL'),
                Markup.button.callback('公众号', 'OFFICIAL'),
                // Markup.button.callback('公司', 'CORPORATION')
            ]);

            // Send message with inline keyboard
            ctx.reply('请选择类型：', inlineKeyboard);

        })

        bot.action(/search/, async ctx => {
            const element = this.searchList.find(item => item.id === ctx.match.input)
            ctx.deleteMessage()
            if (element) {
                if (element.contact?.payload.type === PUPPET.types.Contact.Official) {
                    this._currentSelectContact = element.contact;
                    this.setPin('official', element.contact.name())
                    ctx.answerCbQuery()
                    return
                }
                if (element.type === 0) {
                    this._currentSelectContact = element.contact;
                    const talker = element.contact
                    const alias = await talker.alias()
                    if (alias) {
                        this.setPin('user', alias)
                    } else {
                        this.setPin('user', talker.name())
                    }
                } else {
                    const room = element.contact
                    this.setPin('room', await room.topic())
                    this.selectRoom = room
                }
            }
            ctx.answerCbQuery()
        })

        bot.command('recent', async ctx => {
            if (this.recentUsers.length == 0) {
                ctx.reply('最近联系人为空')
                return
            }

            const buttons: tg.InlineKeyboardButton[][] = []
            this.recentUsers.forEach(item => {
                buttons.push([Markup.button.callback(item.name, item.id)])
            })
            const inlineKeyboard = Markup.inlineKeyboard(buttons);
            ctx.reply('请选择要回复的联系人：', inlineKeyboard);
        })

        bot.action(/.*recent.*/, (ctx) => {
            const data = this.recentUsers.find(item => item.id === ctx.match.input)
            if (data) {
                if (data.type === 0) {
                    this.selectRoom = data.talker;
                } else {
                    this._currentSelectContact = data.talker;
                }
                this.setPin(data.type === 0 ? 'room' : 'user', data.name)
            }
            ctx.deleteMessage()
            ctx.answerCbQuery()
        });

        bot.action(/.*addBlackOrWhite.*/, (ctx) => {
            const data = addBlackOrWhite.find(item => item.id === ctx.match.input)
            if (data) {
                this.addToWhiteOrBlackList(data.text)
            }
            ctx.deleteMessage()
            ctx.answerCbQuery()
        });

        bot.action(/^[0-9a-z]+/, async (ctx) => {
            // ctx.update.callback_query.message
            console.log('点击了用户', ctx.match.input)
            await ctx.reply('请输入消息内容')
            const id = ctx.match.input !== 'filehelper' ? '@' + ctx.match.input : 'filehelper';
            this._currentSelectContact = await this._weChatClient.client.Contact.find({id: id})
            // console.log(ctx.match.input
            const reply = await this._currentSelectContact?.alias() || this._currentSelectContact?.name()
            if (this._currentSelectContact?.type() === PUPPET.types.Contact.Official) {
                this.setPin('official', reply ? reply : '')
            } else {
                this.setPin('user', reply ? reply : '')
            }
            ctx.answerCbQuery()
        })
        let addBlackOrWhite: any[] = []
        // 发送消息 回复等...
        bot.on(message('text'), async ctx => {
            const text = ctx.message.text; // 获取消息内容
            if (listAdd) {
                // 黑白名单添加
                listAdd = false
                addBlackOrWhite = []
                const roomList = this._weChatClient.roomList.filter(room => {
                    // const roomName = ;
                    return room.payload?.topic?.includes(text)
                })
                if (roomList.length === 0) {
                    ctx.reply('未找到该群组,请检查群名称是否正确')
                } else {
                    const buttons: tg.InlineKeyboardButton[][] = [];
                    roomList.forEach(item => {
                        const id = UniqueIdGenerator.getInstance().generateId("addBlackOrWhite")
                        addBlackOrWhite.push({
                            id: id,
                            text: item.payload?.topic
                        })
                        buttons.push([Markup.button.callback(`🌐${item.payload?.topic}`, `${id}`)]);
                    });
                    ctx.reply('请选择群组(点击添加):', Markup.inlineKeyboard(buttons))
                }
                return
            }
            const replyMessageId = ctx.update.message['reply_to_message']?.message_id;
            // 如果是回复的消息 优先回复该发送的消息
            if (replyMessageId) {
                // try get weChat cache message id
                // 假设回复消息是撤回命令
                if (text === '&rm') {
                    const undoMessageCache = CacheHelper.getInstances().getUndoMessageCache(replyMessageId);
                    if (undoMessageCache) {
                        // 撤回消息
                        this.weChatClient.client.Message.find({id: undoMessageCache.wechat_message_id})
                            .then(message => {
                                message?.recall().then(() => {
                                    ctx.reply('撤回成功')
                                }).catch(() => {
                                    ctx.reply('撤回失败')
                                })
                            })
                    } else {
                        ctx.reply('当前消息不能撤回或者已经过期')
                    }
                    return;
                }
                // todo: 可以去找到最原始的消息 非必要
                const weChatMessageId = this._messageMap.get(replyMessageId)
                if (weChatMessageId) {
                    // 添加或者移除名单

                    this.weChatClient.client.Message.find({id: weChatMessageId}).then(message => {
                        message?.say(ctx.message.text).then(msg => {
                            // 保存到undo消息缓存
                            if (msg) {
                                CacheHelper.getInstances().addUndoMessageCache(ctx.message.message_id, msg.id)
                            }
                            if (this.forwardSetting.getVariable(VariableType.SETTING_REPLY_SUCCESS)) {
                                ctx.reply("发送成功!", {
                                    reply_parameters: {
                                        message_id: ctx.message.message_id
                                    }
                                })
                            }
                        }).catch(() => {
                            ctx.deleteMessage();
                            ctx.replyWithHTML(`发送失败 <blockquote>${text}</blockquote>`)
                        });
                    });
                }
                return;
            }

            // 当前有回复的'个人用户' 并且是选择了用户的情况下
            if (this._flagPinMessageType === 'user' && this._currentSelectContact) {
                this._currentSelectContact.say(text)
                    .then((msg) => {
                        if (msg) {
                            CacheHelper.getInstances().addUndoMessageCache(
                                ctx.message.message_id, msg.id)
                        }

                        if (this.forwardSetting.getVariable(VariableType.SETTING_REPLY_SUCCESS)) {
                            ctx.reply("发送成功!", {
                                reply_parameters: {
                                    message_id: ctx.message.message_id
                                }
                            })
                        }
                        // ctx.replyWithHTML(`发送成功 <blockquote>${text}</blockquote>`)
                    })
                    .catch(() => {
                        ctx.deleteMessage();
                        ctx.replyWithHTML(`发送失败 <blockquote>${text}</blockquote>`)
                    })
                // ctx.answerCbQuery('发送成功')
                return;
            }

            // 当前有回复的'群' 并且是选择了群的情况下
            if (this._flagPinMessageType === 'room' && this.selectRoom) {
                this.selectRoom.say(text)
                    .then(msg => {

                        if (msg) {
                            CacheHelper.getInstances().addUndoMessageCache(
                                ctx.message.message_id, msg.id)
                        }

                        if (this.forwardSetting.getVariable(VariableType.SETTING_REPLY_SUCCESS)) {
                            ctx.reply("发送成功!", {
                                reply_parameters: {
                                    message_id: ctx.message.message_id
                                }
                            })
                        }
                        // ctx.replyWithHTML(`发送成功 <blockquote>${text}</blockquote>`)
                    })
                    .catch(() => {
                        ctx.deleteMessage();
                        ctx.replyWithHTML(`发送失败 <blockquote>${text}</blockquote>`)
                    })
                // ctx.answerCbQuery('发送成功')
                return;
            }

            return;
        })

        bot.on(message('voice'), ctx => {
            if (ctx.message.voice) {
                const fileId = ctx.message.voice.file_id;
                ctx.telegram.getFileLink(fileId).then(fileLink => {
                    const nowShangHaiZh = new Date().toLocaleString('zh', {
                        timeZone: 'Asia/ShangHai'
                    }).toString().replaceAll('/', '-')
                    console.log('voice name', nowShangHaiZh)
                    const fileBox = FileBox.fromUrl(fileLink.toString(), {name: `语音-${nowShangHaiZh.toLocaleLowerCase()}.mp3`});
                    const replyMessageId = ctx.update.message['reply_to_message']?.message_id;
                    // 如果是回复的消息 优先回复该发送的消息
                    if (replyMessageId) {
                        // try get weChat cache message id
                        const weChatMessageId = this._messageMap.get(replyMessageId)
                        if (weChatMessageId) {
                            // 添加或者移除名单

                            this.weChatClient.client.Message.find({id: weChatMessageId}).then(message => {
                                message?.say(fileBox).then(msg => {
                                    // 保存到undo消息缓存
                                    if (msg) {
                                        CacheHelper.getInstances().addUndoMessageCache(ctx.message.message_id, msg.id)
                                    }
                                    if (this.forwardSetting.getVariable(VariableType.SETTING_REPLY_SUCCESS)) {
                                        ctx.reply("发送成功!", {
                                            reply_parameters: {
                                                message_id: ctx.message.message_id
                                            }
                                        })
                                    }
                                }).catch(() => {
                                    ctx.reply("发送失败!", {
                                        reply_parameters: {
                                            message_id: ctx.message.message_id
                                        }
                                    })
                                });
                                const text = ctx.message.caption
                                if (text) {
                                    message?.say(text).then(msg => {
                                        if (msg) {
                                            CacheHelper.getInstances().addUndoMessageCache(
                                                ctx.message.message_id, msg.id)
                                        }
                                    }).catch(() => ctx.reply('发送失败'));
                                }
                            });
                        }
                        return;
                    }
                    if (this._flagPinMessageType && this._flagPinMessageType === 'user') {
                        this._currentSelectContact?.say(fileBox).then(msg => {
                            if (msg) {
                                CacheHelper.getInstances().addUndoMessageCache(
                                    ctx.message.message_id, msg.id)
                            }
                        }).catch(() => ctx.reply('发送失败'));
                        const text = ctx.message.caption
                        if (text) {
                            this._currentSelectContact?.say(text).catch(() => ctx.reply('发送失败'));
                        }
                    } else {
                        this.selectRoom?.say(fileBox).then(msg => {
                            if (msg) {
                                CacheHelper.getInstances().addUndoMessageCache(
                                    ctx.message.message_id, msg.id)
                            }
                        }).catch(() => ctx.reply('发送失败'));
                        const text = ctx.message.caption
                        if (text) {
                            this.selectRoom?.say(text).then(msg => {
                                if (msg) {
                                    CacheHelper.getInstances().addUndoMessageCache(
                                        ctx.message.message_id, msg.id)
                                }
                            }).catch(() => ctx.reply('发送失败'));
                        }
                    }
                    if (this.forwardSetting.getVariable(VariableType.SETTING_REPLY_SUCCESS)) {
                        ctx.reply("发送成功!", {
                            reply_parameters: {
                                message_id: ctx.message.message_id
                            }
                        })
                    }
                })
            }
        })

        bot.on(message('audio'), ctx => {
            if (ctx.message.audio) {
                const fileId = ctx.message.audio.file_id;
                ctx.telegram.getFileLink(fileId).then(fileLink => {
                    const fileBox = FileBox.fromUrl(fileLink.toString(), ctx.message.audio.file_name);
                    const replyMessageId = ctx.update.message['reply_to_message']?.message_id;
                    // 如果是回复的消息 优先回复该发送的消息
                    if (replyMessageId) {
                        // try get weChat cache message id
                        const weChatMessageId = this._messageMap.get(replyMessageId)
                        if (weChatMessageId) {
                            // 添加或者移除名单

                            this.weChatClient.client.Message.find({id: weChatMessageId}).then(message => {
                                message?.say(fileBox).then(msg => {
                                    // 保存到undo消息缓存
                                    if (msg) {
                                        CacheHelper.getInstances().addUndoMessageCache(ctx.message.message_id, msg.id)
                                    }
                                    if (this.forwardSetting.getVariable(VariableType.SETTING_REPLY_SUCCESS)) {
                                        ctx.reply("发送成功!", {
                                            reply_parameters: {
                                                message_id: ctx.message.message_id
                                            }
                                        })
                                    }
                                }).catch(() => {
                                    ctx.reply("发送失败!", {
                                        reply_parameters: {
                                            message_id: ctx.message.message_id
                                        }
                                    })
                                });
                                const text = ctx.message.caption
                                if (text) {
                                    message?.say(text).then(msg => {
                                        if (msg) {
                                            CacheHelper.getInstances().addUndoMessageCache(
                                                ctx.message.message_id, msg.id)
                                        }
                                    }).catch(() => ctx.reply('发送失败'));
                                }
                            });
                        }
                        return;
                    }
                    if (this._flagPinMessageType && this._flagPinMessageType === 'user') {
                        this._currentSelectContact?.say(fileBox).then(msg => {
                            if (msg) {
                                CacheHelper.getInstances().addUndoMessageCache(
                                    ctx.message.message_id, msg.id)
                            }
                        }).catch(() => ctx.reply('发送失败'));
                        const text = ctx.message.caption
                        if (text) {
                            this._currentSelectContact?.say(text).catch(() => ctx.reply('发送失败'));
                        }
                    } else {
                        this.selectRoom?.say(fileBox).then(msg => {
                            if (msg) {
                                CacheHelper.getInstances().addUndoMessageCache(
                                    ctx.message.message_id, msg.id)
                            }
                        }).catch(() => ctx.reply('发送失败'));
                        const text = ctx.message.caption
                        if (text) {
                            this.selectRoom?.say(text).then(msg => {
                                if (msg) {
                                    CacheHelper.getInstances().addUndoMessageCache(
                                        ctx.message.message_id, msg.id)
                                }
                            }).catch(() => ctx.reply('发送失败'));
                        }
                    }
                    if (this.forwardSetting.getVariable(VariableType.SETTING_REPLY_SUCCESS)) {
                        ctx.reply("发送成功!", {
                            reply_parameters: {
                                message_id: ctx.message.message_id
                            }
                        })
                    }
                })
            }
        })

        bot.on(message('video'), ctx => {
            if (ctx.message.video) {
                const fileId = ctx.message.video.file_id;
                ctx.telegram.getFileLink(fileId).then(fileLink => {
                    const fileBox = FileBox.fromUrl(fileLink.toString(), ctx.message.video.file_name);
                    const replyMessageId = ctx.update.message['reply_to_message']?.message_id;
                    // 如果是回复的消息 优先回复该发送的消息
                    if (replyMessageId) {
                        // try get weChat cache message id
                        const weChatMessageId = this._messageMap.get(replyMessageId)
                        if (weChatMessageId) {
                            // 添加或者移除名单

                            this.weChatClient.client.Message.find({id: weChatMessageId}).then(message => {
                                message?.say(fileBox).then(msg => {
                                    // 保存到undo消息缓存
                                    if (msg) {
                                        CacheHelper.getInstances().addUndoMessageCache(ctx.message.message_id, msg.id)
                                    }
                                    if (this.forwardSetting.getVariable(VariableType.SETTING_REPLY_SUCCESS)) {
                                        ctx.reply("发送成功!", {
                                            reply_parameters: {
                                                message_id: ctx.message.message_id
                                            }
                                        })
                                    }
                                }).catch(() => {
                                    ctx.reply("发送失败!", {
                                        reply_parameters: {
                                            message_id: ctx.message.message_id
                                        }
                                    })
                                });
                                const text = ctx.message.caption
                                if (text) {
                                    message?.say(text).then(msg => {
                                        if (msg) {
                                            CacheHelper.getInstances().addUndoMessageCache(
                                                ctx.message.message_id, msg.id)
                                        }
                                    }).catch(() => ctx.reply('发送失败'));
                                }
                            });
                        }
                        return;
                    }
                    if (this._flagPinMessageType && this._flagPinMessageType === 'user') {
                        this._currentSelectContact?.say(fileBox).then(msg => {
                            if (msg) {
                                CacheHelper.getInstances().addUndoMessageCache(
                                    ctx.message.message_id, msg.id)
                            }
                        }).catch(() => ctx.reply('发送失败'));
                        const text = ctx.message.caption
                        if (text) {
                            this._currentSelectContact?.say(text).then(msg => {
                                if (msg) {
                                    CacheHelper.getInstances().addUndoMessageCache(
                                        ctx.message.message_id, msg.id)
                                }
                            }).catch(() => ctx.reply('发送失败'));
                        }
                    } else {
                        this.selectRoom?.say(fileBox).then(msg => {
                            if (msg) {
                                CacheHelper.getInstances().addUndoMessageCache(
                                    ctx.message.message_id, msg.id)
                            }
                        }).catch(() => ctx.reply('发送失败'));
                        const text = ctx.message.caption
                        if (text) {
                            this.selectRoom?.say(text).then(msg => {
                                if (msg) {
                                    CacheHelper.getInstances().addUndoMessageCache(
                                        ctx.message.message_id, msg.id)
                                }
                            }).catch(() => ctx.reply('发送失败'));
                        }
                    }
                    if (this.forwardSetting.getVariable(VariableType.SETTING_REPLY_SUCCESS)) {
                        ctx.reply("发送成功!", {
                            reply_parameters: {
                                message_id: ctx.message.message_id
                            }
                        })
                    }
                })
            }
        })

        bot.on(message('document'), ctx => {
            // 转发文件 没有压缩的图片也是文件

            // console.log('发送文件....')

            if (ctx.message.document) {
                const fileId = ctx.message.document.file_id;
                ctx.telegram.getFileLink(fileId).then(fileLink => {
                    const fileBox = FileBox.fromUrl(fileLink.toString(), ctx.message.document.file_name);
                    const replyMessageId = ctx.update.message['reply_to_message']?.message_id;
                    // 如果是回复的消息 优先回复该发送的消息
                    if (replyMessageId) {
                        // try get weChat cache message id
                        const weChatMessageId = this._messageMap.get(replyMessageId)
                        if (weChatMessageId) {
                            // 添加或者移除名单

                            this.weChatClient.client.Message.find({id: weChatMessageId}).then(message => {
                                message?.say(fileBox).then(msg => {
                                    // 保存到undo消息缓存
                                    if (msg) {
                                        CacheHelper.getInstances().addUndoMessageCache(ctx.message.message_id, msg.id)
                                    }
                                    if (this.forwardSetting.getVariable(VariableType.SETTING_REPLY_SUCCESS)) {
                                        ctx.reply("发送成功!", {
                                            reply_parameters: {
                                                message_id: ctx.message.message_id
                                            }
                                        })
                                    }
                                }).catch(() => {
                                    ctx.reply("发送失败!", {
                                        reply_parameters: {
                                            message_id: ctx.message.message_id
                                        }
                                    })
                                });
                                const text = ctx.message.caption
                                if (text) {
                                    message?.say(text).then(msg => {
                                        if (msg) {
                                            CacheHelper.getInstances().addUndoMessageCache(
                                                ctx.message.message_id, msg.id)
                                        }
                                    }).catch(() => ctx.reply('发送失败'));
                                }
                            });
                        }
                        return;
                    }
                    if (this._flagPinMessageType && this._flagPinMessageType === 'user') {
                        this._currentSelectContact?.say(fileBox).then(msg => {
                            if (msg) {
                                CacheHelper.getInstances().addUndoMessageCache(
                                    ctx.message.message_id, msg.id)
                            }
                        }).catch(() => ctx.reply('发送失败'));
                        const text = ctx.message.caption
                        if (text) {
                            this._currentSelectContact?.say(text).then(msg => {
                                if (msg) {
                                    CacheHelper.getInstances().addUndoMessageCache(
                                        ctx.message.message_id, msg.id)
                                }
                            }).catch(() => ctx.reply('发送失败'));
                        }
                    } else {
                        this.selectRoom?.say(fileBox).then(msg => {
                            if (msg) {
                                CacheHelper.getInstances().addUndoMessageCache(
                                    ctx.message.message_id, msg.id)
                            }
                        }).catch(() => ctx.reply('发送失败'));
                        const text = ctx.message.caption
                        if (text) {
                            this.selectRoom?.say(text).then(msg => {
                                if (msg) {
                                    CacheHelper.getInstances().addUndoMessageCache(
                                        ctx.message.message_id, msg.id)
                                }
                            }).catch(() => ctx.reply('发送失败'));
                        }
                    }
                    if (this.forwardSetting.getVariable(VariableType.SETTING_REPLY_SUCCESS)) {
                        ctx.reply("发送成功!", {
                            reply_parameters: {
                                message_id: ctx.message.message_id
                            }
                        })
                    }
                })
            }
        });

        bot.on(message('photo'), async ctx => {
            if (ctx.message.photo) {
                // Get the file_id of the largest size photo
                const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
                // const fileId = ctx.message.photo[ctx.message.photo.length - 1];

                // Get the file link using telegram API
                ctx.telegram.getFileLink(fileId).then(fileLink => {
                    // Create a FileBox from URL
                    const fileBox = FileBox.fromUrl(fileLink.toString());
                    const replyMessageId = ctx.update.message['reply_to_message']?.message_id;
                    // 如果是回复的消息 优先回复该发送的消息
                    if (replyMessageId) {
                        // try get weChat cache message id
                        const weChatMessageId = this._messageMap.get(replyMessageId)
                        if (weChatMessageId) {
                            // 添加或者移除名单

                            this.weChatClient.client.Message.find({id: weChatMessageId}).then(message => {
                                message?.say(fileBox).then(msg => {
                                    // 保存到undo消息缓存
                                    if (msg) {
                                        CacheHelper.getInstances().addUndoMessageCache(ctx.message.message_id, msg.id)
                                    }
                                    if (this.forwardSetting.getVariable(VariableType.SETTING_REPLY_SUCCESS)) {
                                        ctx.reply("发送成功!", {
                                            reply_parameters: {
                                                message_id: ctx.message.message_id
                                            }
                                        })
                                    }
                                }).catch(() => {
                                    ctx.reply("发送失败!", {
                                        reply_parameters: {
                                            message_id: ctx.message.message_id
                                        }
                                    })
                                });
                                const text = ctx.message.caption
                                if (text) {
                                    message?.say(text).then(msg => {
                                        if (msg) {
                                            CacheHelper.getInstances().addUndoMessageCache(
                                                ctx.message.message_id, msg.id)
                                        }
                                    }).catch(() => ctx.reply('发送失败'));
                                }
                            });
                        }
                        return;
                    }

                    // Send the FileBox to the contact
                    if (this._flagPinMessageType && this._flagPinMessageType === 'user') {
                        this._currentSelectContact?.say(fileBox).then(msg => {
                            if (msg) {
                                CacheHelper.getInstances().addUndoMessageCache(
                                    ctx.message.message_id, msg.id)
                            }
                        }).catch(() => ctx.reply('发送失败'));
                        const text = ctx.message.caption
                        if (text) {
                            this._currentSelectContact?.say(text).then(msg => {
                                if (msg) {
                                    CacheHelper.getInstances().addUndoMessageCache(
                                        ctx.message.message_id, msg.id)
                                }
                            }).catch(() => ctx.reply('发送失败'));
                        }
                    } else {
                        this.selectRoom?.say(fileBox)
                        const text = ctx.message.caption
                        if (text) {
                            this.selectRoom?.say(text).then(msg => {
                                if (msg) {
                                    CacheHelper.getInstances().addUndoMessageCache(
                                        ctx.message.message_id, msg.id)
                                }
                            }).catch(() => ctx.reply('发送失败'));
                        }
                    }
                    if (this.forwardSetting.getVariable(VariableType.SETTING_REPLY_SUCCESS)) {
                        ctx.reply("发送成功!", {
                            reply_parameters: {
                                message_id: ctx.message.message_id
                            }
                        })
                    }
                })
            }
        })

        bot.on(message('sticker'), ctx => {
            const fileId = ctx.message.sticker.file_id
            ctx.telegram.getFileLink(fileId).then(fileLink => {
                const uniqueId = ctx.message.sticker.file_unique_id
                // 判断文件夹是否存在
                if (!fs.existsSync("save-files")) {
                    fs.mkdirSync("save-files");
                }
                const saveFile = `save-files/${uniqueId}`; // 不用后缀
                const gifFile = `save-files/${uniqueId}.gif`;

                // 保存后不删除下次发送使用

                // 文件存在
                if (fs.existsSync(saveFile)) {
                    if (fs.existsSync(gifFile)) {
                        const fileBox = FileBox.fromFile(gifFile);
                        const replyMessageId = ctx.update.message['reply_to_message']?.message_id;
                        // 如果是回复的消息 优先回复该发送的消息
                        if (replyMessageId) {
                            // try get weChat cache message id
                            const weChatMessageId = this._messageMap.get(replyMessageId)
                            if (weChatMessageId) {
                                // 添加或者移除名单

                                this.weChatClient.client.Message.find({id: weChatMessageId}).then(message => {
                                    message?.say(fileBox).then(msg => {
                                        // 保存到undo消息缓存
                                        if (msg) {
                                            CacheHelper.getInstances().addUndoMessageCache(ctx.message.message_id, msg.id)
                                        }
                                        if (this.forwardSetting.getVariable(VariableType.SETTING_REPLY_SUCCESS)) {
                                            ctx.reply("发送成功!", {
                                                reply_parameters: {
                                                    message_id: ctx.message.message_id
                                                }
                                            })
                                        }
                                    }).catch(() => {
                                        ctx.reply("发送失败!", {
                                            reply_parameters: {
                                                message_id: ctx.message.message_id
                                            }
                                        })
                                    });
                                });
                            }
                            return;
                        }
                        if (this._flagPinMessageType && this._flagPinMessageType === 'user') {
                            this._currentSelectContact?.say(fileBox).then(msg => {
                                if (msg) {
                                    CacheHelper.getInstances().addUndoMessageCache(
                                        ctx.message.message_id, msg.id)
                                }
                                if (this.forwardSetting.getVariable(VariableType.SETTING_REPLY_SUCCESS)) {
                                    ctx.reply("发送成功!", {
                                        reply_parameters: {
                                            message_id: ctx.message.message_id
                                        }
                                    })
                                }
                            }).catch(() => ctx.reply('发送失败'));
                        } else {
                            this.selectRoom?.say(fileBox).then(msg => {
                                if (msg) {
                                    CacheHelper.getInstances().addUndoMessageCache(
                                        ctx.message.message_id, msg.id)
                                }
                                if (this.forwardSetting.getVariable(VariableType.SETTING_REPLY_SUCCESS)) {
                                    ctx.reply("发送成功!", {
                                        reply_parameters: {
                                            message_id: ctx.message.message_id
                                        }
                                    })
                                }
                            }).catch(() => ctx.reply('发送失败'));
                        }
                    } else { // 文件不存在转换
                        this.sendGif(saveFile, gifFile, ctx);
                    }
                } else {
                    // 尝试使用代理下载tg文件
                    if (config.HOST !== '') {
                        FileUtils.downloadWithProxy(fileLink.toString(), saveFile).then(() => {
                            this.sendGif(saveFile, gifFile, ctx);
                        }).catch(() => ctx.reply('发送失败, 原始文件保存失败'))
                    } else {
                        FileBox.fromUrl(fileLink.toString()).toFile(saveFile).then(() => {
                            this.sendGif(saveFile, gifFile, ctx);
                        }).catch(() => ctx.reply('发送失败, 原始文件保存失败'))
                    }
                }
            })
        })

        // const unknownPage = 0;
        const individualPage = 0;
        const officialPage = 0;
        // const corporationPage = 0;
        // const contactMap = this._weChatClient.contactMap;

        // bot.action('UNKNOWN',
        //     ctx => this.pageContacts(ctx, contactMap?.get(0), unknownPage, currentSearchWord));
        bot.action('INDIVIDUAL', ctx => {
            this.pageContacts(ctx, [...this._weChatClient.contactMap?.get(ContactImpl.Type.Individual) || []], individualPage, currentSearchWord)
            ctx.answerCbQuery()
        });
        bot.action('OFFICIAL', ctx => {
            this.pageContacts(ctx, [...this._weChatClient.contactMap?.get(ContactImpl.Type.Official) || []], officialPage, currentSearchWord)
            ctx.answerCbQuery()
        });
        // bot.action('CORPORATION',
        //     ctx => this.pageContacts(ctx, contactMap?.get(ContactImpl.Type.Corporation), corporationPage, currentSearchWord));


        bot.launch().then(() => {
            console.log('Telegram Bot started')
        }).catch((err) => {
            console.error('Telegram Bot start failed', err)
        });

    }

    private async sendGif(saveFile: string, gifFile: string, ctx: NarrowedContext<Context<tg.Update>, tg.Update>) {
        new ConverterHelper().webmToGif(saveFile, gifFile).then(() => {
            const fileBox = FileBox.fromFile(gifFile);
            if (this._flagPinMessageType && this._flagPinMessageType === 'user') {
                this._currentSelectContact?.say(fileBox).then(msg => {
                    if (msg && ctx.message) {
                        CacheHelper.getInstances().addUndoMessageCache(
                            ctx.message.message_id, msg.id)
                    }
                }).catch(() => ctx.reply('发送失败'));
            } else {
                this.selectRoom?.say(fileBox).catch(() => ctx.reply('发送失败'));
            }
            if (this.forwardSetting.getVariable(VariableType.SETTING_REPLY_SUCCESS)) {
                ctx.reply("发送成功!", {
                    reply_parameters: {
                        message_id: ctx.message?.message_id ? ctx.message?.message_id : 0
                    }
                })
            }
        }).catch(() => ctx.reply('发送失败'))
    }

    public onMessage() {
        return;
    }

    public async sendMessage(message: SimpleMessage) {
        // console.log('发送文本消息', message)
        const res = await this.bot.telegram.sendMessage(this._chatId, SimpleMessageSender.send(message), {
            parse_mode: 'HTML'
        });
        if (message.id) {
            this.messageMap.set(res.message_id, message.id);
        }
    }

    private async pageContacts(ctx: NarrowedContext<Context<tg.Update>, tg.Update>, source: ContactInterface[] | undefined, pageNumber: number, currentSearchWord: string) {


        if (!source) {
            await ctx.reply('没有联系人');
        }
        source = await TelegramClient.filterByNameAndAlias(currentSearchWord, source);

        let buttons: tg.InlineKeyboardButton[][] = await this.pageDataButtons(source, pageNumber,
            TelegramClient.PAGE_SIZE, TelegramClient.LINES);

        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const that = this;

        if (pageNumber != 0) {
            this._bot.action(/(&page:1-next-|&page:1-perv-)(\d+)/, async (ctu) => {
                buttons = await this.toButtons({ctu: ctu, source: source, code: "&page:1-next-"});
                ctu.answerCbQuery()
            })

            this._bot.action(/(&page:2-next-|&page:2-perv-)(\d+)/, async (ctu) => {
                buttons = await this.toButtons({ctu: ctu, source: source, code: "&page:2-next-"});
                ctu.answerCbQuery()
            })
        } else {
            const thatContactMap = that.weChatClient.contactMap;

            let source1: ContactInterface[] | undefined = [...thatContactMap?.get(1) || []];
            let source2: ContactInterface[] | undefined = [...thatContactMap?.get(2) || []];

            source1 = await TelegramClient.filterByNameAndAlias(currentSearchWord, source1);
            source2 = await TelegramClient.filterByNameAndAlias(currentSearchWord, source2);


            this._bot.action(/(&page:1-next-|&page:1-perv-)(\d+)/, async (ctu) => {
                buttons = await this.toButtons({ctu: ctu, source: source1, code: "&page:1-next-"});
                ctu.answerCbQuery()
            })

            this._bot.action(/(&page:2-next-|&page:2-perv-)(\d+)/, async (ctu) => {
                buttons = await this.toButtons({ctu: ctu, source: source2, code: "&page:2-next-"});
                ctu.answerCbQuery()
            })
        }

        ctx.reply('请选择联系人(点击回复):', {
            ...Markup.inlineKeyboard(buttons),
        })

    }

    private async toButtons({ctu, source, code}: { ctu: any, source: ContactInterface[] | undefined, code: string }) {
        let pageNumber = parseInt(ctu.match[2]);
        // const prefix = ctx.match[0].slice(0, 1)
        const direction = ctu.match[1];

        let nextPageNum = 0;

        nextPageNum = direction === code ? pageNumber += 1 : pageNumber -= 1;
        // 修改 prefix1 对应的变量 todo
        ctu.editMessageReplyMarkup({
            inline_keyboard:
                [...await this.pageDataButtons(source, nextPageNum, TelegramClient.PAGE_SIZE, TelegramClient.LINES)]
        })
        return await this.pageDataButtons(source, pageNumber, TelegramClient.PAGE_SIZE, TelegramClient.LINES);
    }

    private static async filterByNameAndAlias(currentSearchWord: string, source: ContactInterface[] | undefined): Promise<ContactInterface[] | undefined> {
        if (currentSearchWord && currentSearchWord.length > 0 && source) {
            return (await Promise.all(
                source.map(async it => {
                    const alias = await it.alias();
                    if (it.name().includes(currentSearchWord) || (alias && alias.includes(currentSearchWord))) {
                        return it;
                    } else {
                        return null;
                    }
                })
            )).filter(it => it !== null) as ContactInterface[];
        }
        return source;
    }

    private async pageDataButtons(source: ContactInterface[] | undefined, page: number, pageSize: number, lines: number) {
        if (source === undefined) {
            return [];
        }
        const start = page * pageSize;
        const end = start + pageSize;
        const slice = source.slice(start, end);

        const type = source[0]?.type();

        const nextButton = Markup.button.callback('下一页', `&page:${type}-next-${page}`);
        const pervButton = Markup.button.callback('上一页', `&page:${type}-perv-${page}`);

        const buttons = []
        for (let i = 0; i < slice.length; i += lines) {
            const row = []
            for (let j = i; j < i + lines && j < slice.length; j++) {
                const alias = await slice[j].alias();
                if (!slice[j].isReady()) {
                    await slice[j].sync()
                }
                row.push(Markup.button.callback(alias ? `[${alias}] ${slice[j].name()}` : slice[j].name(), slice[j].id.replace(/@/, '')))
            }
            buttons.push(row);
        }
        // console.warn('buttons', buttons)

        if (buttons.length > 0) {
            if (page > 0 && end < source.length) {
                buttons.push([pervButton, nextButton]);
            } else {
                if (page > 0) {
                    buttons.push([pervButton]);
                }
                if (end < source.length) {
                    buttons.push([nextButton]);
                }
            }
        }

        return buttons;
    }

    private loadOwnerChat(ctx: NarrowedContext<Context<tg.Update>, tg.Update>) {
        try {

            const ownerFile = `${StorageSettings.STORAGE_FOLDER}/${StorageSettings.OWNER_FILE_NAME}`
            // 检查存储文件夹是否存在，不存在则创建
            if (!fs.existsSync(StorageSettings.STORAGE_FOLDER)) {
                fs.mkdirSync(ownerFile);
            }

            // 检查所有者文件是否存在
            if (fs.existsSync(ownerFile)) {
                // 读取文件并设置所有者和聊天 ID
                const ownerData = fs.readFileSync(ownerFile, 'utf8');
                const {owner_id, chat_id} = JSON.parse(ownerData);
                this._ownerId = owner_id ? owner_id : ctx.from?.id;
                this._chatId = chat_id ? chat_id : ctx.chat?.id;
            } else {
                // 创建并写入新的所有者文件
                const ownerData = {
                    owner_id: ctx.from?.id,
                    chat_id: ctx.message?.chat.id
                };
                fs.writeFileSync(ownerFile, JSON.stringify(ownerData, null, 2));
                this._ownerId = typeof ownerData.owner_id === 'number' ? ownerData.owner_id : 0
                this._chatId = typeof ownerData.chat_id === 'number' ? ownerData.chat_id : 0;
            }

        } catch (error) {
            console.error('Error loading owner data:', error);
        }
    }


    private loadForwardSettings() {
        // 没有就创建
        try {
            if (!fs.existsSync(StorageSettings.STORAGE_FOLDER)) {
                fs.mkdirSync(StorageSettings.STORAGE_FOLDER);
            }
            const variableContainer = new VariableContainer();
            variableContainer.parseFromFile();
            this.forwardSetting = variableContainer;
        } catch (error) {
            console.error('Error loading owner data:', error);

        }

    }

    public async findPinMessage() {
        //找到pin消息
        const chatInfo = await this._bot.telegram.getChat(this.chatId)
        if (chatInfo.pinned_message) {
            this.pinnedMessageId = chatInfo.pinned_message.message_id
            this._bot.telegram.editMessageText(this.chatId, this.pinnedMessageId, undefined, "当前无回复用户").then((res) => {
                if (typeof res !== 'boolean') {
                    this._bot.telegram.pinChatMessage(this._chatId, res.message_id)
                }
            }).catch(e => {
                //名字相同不用管
                if (e.response.error_code === 400) {
                    return
                }
                this._bot.telegram.sendMessage(this._chatId, "当前无回复用户").then(msg => {
                    this._bot.telegram.pinChatMessage(this._chatId, msg.message_id).then(() => {
                        this.pinnedMessageId = msg.message_id
                    });
                })
            })
        }else {
            // 发送消息并且pin
            this._bot.telegram.sendMessage(this._chatId, `当前无回复用户`).then(msg => {
                this._bot.telegram.pinChatMessage(this._chatId, msg.message_id);
                this.pinnedMessageId = msg.message_id
            })
        }
    }

    private setPin(type: string, name: string | undefined) {
        // 判断是否是群组
        let str = ''
        if (type === 'user') {
            str = `当前回复用户:👤 ${name}`
            this._flagPinMessageType = type;
        } else if (type === 'room') {
            str = `当前回复群组:🌐 ${name}`
            this._flagPinMessageType = type;
        } else if (type === 'official') {
            str = `当前回复公众号:📣 ${name}`
            this._flagPinMessageType = 'user';
        }
        if (this.pinnedMessageId) {
            // 修改pin的内容
            // let editMessageSuccess = true;
            this._bot.telegram.editMessageText(this._chatId, this.pinnedMessageId, undefined, str).then(async (res) => {
                if (typeof res !== 'boolean') {
                    this._bot.telegram.pinChatMessage(this._chatId, res.message_id)
                }
            }).catch(e => {
                // 名字相同不用管
                // pin消息被删除了
                // 发送消息并且pin
                if (e.response.error_code === 400) {
                    return
                }
            })
        } else {
            // 发送消息并且pin
            this._bot.telegram.sendMessage(this._chatId, str).then(msg => {
                this._bot.telegram.pinChatMessage(this._chatId, msg.message_id).then(() => {
                    this.pinnedMessageId = msg.message_id
                });
            })
        }
    }


    public onWeChatLogout(ctx: NarrowedContext<Context<tg.Update>, tg.Update>) {

        this._weChatClient.logout().then(() => {
            ctx.reply('登出成功').then(() => this.loginCommandExecuted = false);
        }).catch(() => ctx.reply('登出失败'))
    }

    public onWeChatStop(ctx: NarrowedContext<Context<tg.Update>, tg.Update>) {
        this.wechatStartFlag = false
        this._weChatClient.stop().then(() => {
            ctx.reply('停止成功').then(() => this.loginCommandExecuted = false);
        }).catch(() => ctx.reply('停止失败'))
    }

    private async generateRoomButtons(rooms: RoomInterface[], currentSelectRoomMap: Map<string, RoomInterface>, page: number) {
        const size = TelegramClient.PAGE_SIZE
        const lineSize = TelegramClient.LINES
        const buttons: tg.InlineKeyboardButton[][] = [];
        const currentIndex = size * page;
        const nextIndex = size * (page + 1);
        const slice = rooms.slice(currentIndex, nextIndex);

        for (let i = 0; i < slice.length; i += lineSize) {
            const row = [];
            for (let j = i; j < i + lineSize && j < slice.length; j++) {
                const keyboard = {
                    text: '🌐' + await slice[j]?.topic(),
                    data: 'room-index-' + j
                }
                currentSelectRoomMap.set(keyboard.data, rooms[j]);
                row.push(Markup.button.callback(keyboard.text, keyboard.data))
            }
            buttons.push(row);
        }

        const nextButton = Markup.button.callback('下一页', 'room-next-' + (page + 1));
        const prevButton = Markup.button.callback('上一页', 'room-next-' + (page - 1));

        if (buttons.length > 0) {
            if (page > 0 && nextIndex < rooms.length) {
                buttons.push([prevButton, nextButton]);
            } else {
                if (page > 0) {
                    buttons.push([prevButton]);
                }
                if (nextIndex < rooms.length) {
                    buttons.push([nextButton]);
                }
            }
        }

        return buttons;
    }

    private async generateNotionListButtons(list: NotionListType[], page: number, keyPrefix: string) {
        const size = TelegramClient.PAGE_SIZE
        const lineSize = TelegramClient.LINES
        const buttons: tg.InlineKeyboardButton[][] = [];
        const currentIndex = size * page;
        const nextIndex = size * (page + 1);
        const slice = list.slice(currentIndex, nextIndex);

        for (let i = 0; i < slice.length; i += lineSize) {
            const row = [];
            for (let j = i; j < i + lineSize && j < slice.length; j++) {
                row.push(Markup.button.callback(slice[j].name, keyPrefix + slice[j].id))
            }
            buttons.push(row);
        }

        const addList = Markup.button.callback('点我添加', 'listAdd-' + keyPrefix);

        const nextButton = Markup.button.callback('获取列表', keyPrefix + (page + 1));

        buttons.push([addList])

        if (page === 0 && buttons.length !== 0 && nextIndex >= list.length) {
            buttons.push([nextButton]);
        }

        return buttons;
    }

    public async calcShowMemberList(): Promise<void> {

        if (!this.calcShowMemberListExecuted) {
            // 从微信实例中获取缓存的联系人 转换成一样的数组
            const contactMap = this._weChatClient.contactMap;
            const roomList = this._weChatClient.roomList;
            const res: MemberCacheType [] = [];

            const idGenerator = UniqueIdGenerator.getInstance();

            contactMap?.forEach(it => {
                it.forEach(contact => {
                    res.push({
                        id: contact.id,
                        show_name: contact.payload?.alias ? `[${contact.payload.alias}] ${contact.name()}` : contact.name(),
                        shot_id: idGenerator.generateId('user'),
                    })
                })
            })
            for (const it of roomList) {
                res.push({
                    id: it.id,
                    show_name: await it.topic(),
                    shot_id: idGenerator.generateId('room'),
                });
            }

            this.calcShowMemberListExecuted = true;
            this._weChatClient.memberCache = res;
        }
    }

    private addToWhiteOrBlackList(text: string) {
        if (this.forwardSetting.getVariable(VariableType.SETTING_NOTION_MODE) === NotionMode.BLACK) {
            const blackList = this.forwardSetting.getVariable(VariableType.SETTING_BLACK_LIST);
            const find = blackList.find(item => item.name === text);
            // 计算id
            let id = 1
            if (blackList.length > 0) {
                id = parseInt(blackList[blackList.length - 1].id) + 1
            }
            if (!find) {
                blackList.push({id: id + '', name: text})
                this.bot.telegram.sendMessage(this.chatId, "添加成功")
            }
        } else {
            const whiteList = this.forwardSetting.getVariable(VariableType.SETTING_WHITE_LIST);
            const find = whiteList.find(item => item.name === text);
            // 计算id
            let id = 1
            if (whiteList.length > 0) {
                id = parseInt(whiteList[whiteList.length - 1].id) + 1
            }
            if (!find) {
                whiteList.push({id: id + '', name: text})
                this.bot.telegram.sendMessage(this.chatId, "添加成功")
            }
        }
        this.forwardSetting.writeToFile()
    }

    private getSettingButton() {
        return {
            inline_keyboard: [
                [Markup.button.callback(`消息模式切换(${this.forwardSetting.getVariable(VariableType.SETTING_NOTION_MODE) === NotionMode.BLACK ? '黑名单模式' : '白名单模式'})`, VariableType.SETTING_NOTION_MODE),],
                [Markup.button.callback(`反馈发送成功(${this.forwardSetting.getVariable(VariableType.SETTING_REPLY_SUCCESS) ? '开启' : '关闭'})`, VariableType.SETTING_REPLY_SUCCESS),],
                [Markup.button.callback(`自动切换联系人(${this.forwardSetting.getVariable(VariableType.SETTING_AUTO_SWITCH) ? '开启' : '关闭'})`, VariableType.SETTING_AUTO_SWITCH),],
                [Markup.button.callback(`接收公众号消息(${this.forwardSetting.getVariable(VariableType.SETTING_ACCEPT_OFFICIAL_ACCOUNT) ? '关闭' : '开启'})`, VariableType.SETTING_ACCEPT_OFFICIAL_ACCOUNT),],
                [Markup.button.callback(`转发自己在微信发送的消息(${this.forwardSetting.getVariable(VariableType.SETTING_FORWARD_SELF) ? '开启' : '关闭'})`, VariableType.SETTING_FORWARD_SELF),],
                [Markup.button.callback(`媒体质量压缩(${this.forwardSetting.getVariable(VariableType.SETTING_COMPRESSION) ? '开启' : '关闭'})`, VariableType.SETTING_COMPRESSION),],
                [this.forwardSetting.getVariable(VariableType.SETTING_NOTION_MODE) === NotionMode.WHITE ?
                    Markup.button.callback('白名单群组', VariableType.SETTING_WHITE_LIST) :
                    Markup.button.callback('黑名单群组', VariableType.SETTING_BLACK_LIST)]
            ],
        }
    }
}
