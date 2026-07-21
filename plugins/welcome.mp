# 欢迎插件 v3.0
name: "welcome"
version: "3.0.0"
author: "Vexify"
desc: "自动欢迎、智能响应、小游戏"

if event == "join":
    pl.broadcast("🎉 {peer} 加入了房间 {room}!")
    pl.log("新用户加入: {peer} @ {time}")

if event == "leave":
    pl.broadcast("👋 {peer} 离开了房间")

if event == "message":
    if "hello" in message or "你好" in message:
        pl.print("{pick:你好！欢迎！,哈喽！很高兴见到你！,Hi there! 欢迎来到这里！,嘿！欢迎！} 🎊")
    if "help" in message or "帮助" in message:
        pl.print("可用命令: /hello /time /date /info /dice /coin /joke /8ball")
    if message == "ping":
        pl.print("pong! 🏓")
    if message == "版本" or message == "version":
        pl.print("MineP2P v4.5.0 | 房间: {room} | 时间: {time}")

if command == "/hello":
    pl.print("{pick:Hello! 你好世界！,世界你好！,哈喽世界！,Bonjour le monde!} 🌍")

if command == "/time":
    pl.print("🕐 当前时间: {time}")

if command == "/date":
    pl.print("📅 今天是: {date}")

if command == "/info":
    pl.print("📦 房间: {room} | 时间: {time} | 用户: {peer}")

if command == "/dice":
    if args == "":
        pl.print("🎲 你掷出了 {rand:1-6} 点!")
    else:
        pl.print("🎲 {args}: {rand:1-6} 点!")

if command == "/coin":
    pl.print("🪙 {coin}!")

if command == "/joke":
    pl.print("😄 {pick:为什么程序员喜欢黑暗模式？因为光会吸引bug！,程序员最讨厌的数字？404！,怎么定义递归？请参考'怎么定义递归'。,0是假1是真，那2是什么？Bug。,为什么程序员总分不清万圣节和圣诞节？因为 Oct 31 == Dec 25。}")

if command == "/8ball":
    pl.print("🎱 {pick:毫无疑问,是的,当然,不确定,再问一次,不可能,绝对不是,想都别想,前途光明,迹象指向是,我的回复是不,高度怀疑,无法预测,专注点再问,别指望了}")
