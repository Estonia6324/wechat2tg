export interface BindItem {
    name: string
    chat_id: number
    // 类型:0-用户,1-群组
    type: number | 0 | 1
    // 绑定的id
    bind_id: string
    // 别名
    alias: string
    // 微信的动态id
    wechat_id: string
}