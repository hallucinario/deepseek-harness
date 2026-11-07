---
kind: upgrade-guide
description: "Schedule 目录现在将已暂停提醒与活动及已结束提醒区分。"
---

# 处理已暂停的 Schedule 记录

[English](guide.md) | 中文

## 变更

Schedule 目录及域记录除 `active` 和 `inactive` 外还接受 `status: paused`。假定只有两种状态的消费者必须处理暂停记录。暂停禁止后续接收，保留 ID、原始 Session 和投递历史，不取消已进入收件箱的请求或活动轮次。恢复逾期循环提醒会跳过已过时段并保留配置的时区。

## 迁移

1. 更新对 `ScheduleCatalogEntry.status` 的穷举处理，单独显示 `paused` 并保留历史访问。使用 `schedule.setPaused({ id, sessionId, paused })` 更改接收状态。
2. 使用暂停前同时升级 Schedule 读写端。旧读取端不接受新的持久状态，不要用旧实现重新打开已暂停数据。现有活动或已结束记录不需转换。
3. 在定期执行页面暂停并恢复提醒，确认 ID 和已保存投递记录保持不变，并区分投递与执行成功。
