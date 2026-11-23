import assert from "node:assert/strict"
import { test } from "vite-plus/test"

import { rewriteCheckinNotice } from "../web/utils/checkin-notice.ts"

const HINT = " · 全部渠道签到明细见「总览 → 自动签到」"

test("去无账号 + 有账号按数量降序在前 + 末尾引导", () => {
  const input =
    "一键签到：CodeArts 2 个签到成功（+30积分），Loomy 无账号，Gemini 5 个今日已领，Raccoon 无账号（共 +30积分）"
  assert.equal(
    rewriteCheckinNotice(input),
    `一键签到：Gemini 5 个今日已领，CodeArts 2 个签到成功（+30积分）（共 +30积分）${HINT}`,
  )
})

test("「暂无活动」算有账号，保留不省略", () => {
  const input = "一键签到：CodeArts 1 个暂无活动，Gemini 无账号"
  assert.equal(rewriteCheckinNotice(input), `一键签到：CodeArts 1 个暂无活动${HINT}`)
})

test("全部无账号时回退为没有可领取，仍加引导", () => {
  assert.equal(rewriteCheckinNotice("一键签到：A 无账号，B 无账号"), `一键签到：没有可领取的渠道${HINT}`)
})

test("上游原本的空结果也加引导", () => {
  assert.equal(rewriteCheckinNotice("一键签到：没有可领取的渠道"), `一键签到：没有可领取的渠道${HINT}`)
})

test("非一键签到文本原样返回（不碰「全部渠道：」全量提示）", () => {
  const other = "全部渠道：CodeArts +30积分；Gemini 无账号（共 +30积分）"
  assert.equal(rewriteCheckinNotice(other), other)
  assert.equal(rewriteCheckinNotice(""), "")
})

test("幂等：已改写过的不重复加引导", () => {
  const once = rewriteCheckinNotice("一键签到：CodeArts 2 个签到成功，Gemini 无账号")
  assert.equal(rewriteCheckinNotice(once), once)
})
