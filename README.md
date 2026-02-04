
---

# 软件开发需求说明书（SRS）

## 项目名称

**Mobile Web Realtime Audio Streaming System**

## 版本

v1.0

## 编写目的

定义一个**无需开发 iOS 原生 App**、仅通过 **iPhone Safari 浏览器** 即可实现的 **实时麦克风音频采集 → 实时传输 → 服务器处理（ASR/存储）** 的系统需求，用于工程实现、评审和验收。

---

## 1. 背景与目标

### 1.1 背景

* 业务需要从 iPhone 实时获取用户语音音频
* 不希望开发和维护 iOS 原生 App
* 音频需实时传输到自有服务器，用于：

  * 实时语音识别（ASR）
  * 后续分析 / 存储 / 转发

### 1.2 目标

* 用户仅通过 **Safari 打开网页** 即可授权麦克风并开始实时传输
* 端到端延迟目标：**≤ 1 秒**
* 支持长时间稳定运行（≥ 30 分钟）
* 服务器可对音频进行实时消费（如 ASR）

---

## 2. 总体架构

### 2.1 架构概览（逻辑）

```
iPhone Safari
  └── Web Audio API (Mic)
        └── AudioWorklet
              └── PCM / Opus Frame
                    └── WebSocket (WSS)
                          └── Audio Ingest Server
                                ├── Realtime ASR
                                ├── Buffer / Queue
                                └── Optional Storage
```

### 2.2 通信方式选择

* **音频上行**：WebSocket over TLS（`wss://`）
* **编码格式（v1）**：PCM16 @ 16kHz（优先简单、低不确定性）
* **编码格式（v2 可选）**：Opus（节省带宽）

---

## 3. 功能需求

### 3.1 前端（Mobile Web）

#### 3.1.1 麦克风采集

* 使用 `navigator.mediaDevices.getUserMedia({ audio: true })`
* 仅支持 Safari（iOS 16+）
* 页面首次进入需触发系统麦克风授权弹窗

#### 3.1.2 音频处理

* 使用 `AudioContext + AudioWorklet`
* 输入：

  * Safari 默认采样率（通常 44.1k / 48k）
* 处理：

  * Downsample → 16,000 Hz
  * Float32 → PCM16
  * 按固定帧长切分（20ms / 320 samples）

#### 3.1.3 音频发送

* 通过 WebSocket 实时发送音频帧
* 每个音频帧必须包含：

  * 帧序号（seq）
  * 时间戳（client_ts）
  * Base64 编码的音频数据

#### 3.1.4 控制能力

* 开始采集
* 暂停采集
* 停止并关闭会话
* 网络断开自动重连（保留 session_id）

---

### 3.2 后端（Audio Ingest Server）

#### 3.2.1 WebSocket 接入

* Endpoint：

  ```
  wss://api.example.com/ws/audio
  ```
* 支持多并发连接
* 支持身份鉴权（JWT / API Key）

#### 3.2.2 音频帧接收

* 按 `session_id` 区分不同客户端
* 校验：

  * seq 连续性
  * 音频帧大小
* 可容忍乱序（≤ N 帧）

#### 3.2.3 实时处理

* 将音频帧实时推送至：

  * ASR 引擎（如 Qwen ASR Realtime / 自研 ASR）
* 支持：

  * 流式转写
  * 断句检测（VAD 可在服务端完成）

#### 3.2.4 数据回传（可选）

* 服务端可通过同一 WebSocket 向前端回传：

  * 实时识别文本
  * 会话状态事件

---

## 4. 通信协议定义（WebSocket）

### 4.1 会话初始化

```json
{
  "type": "session.start",
  "session_id": "uuid",
  "sample_rate": 16000,
  "format": "pcm16",
  "client": "ios_safari"
}
```

---

### 4.2 音频帧消息

```json
{
  "type": "audio.frame",
  "session_id": "uuid",
  "seq": 1024,
  "timestamp": 1710000000123,
  "audio": "BASE64_PCM16"
}
```

---

### 4.3 会话结束

```json
{
  "type": "session.stop",
  "session_id": "uuid"
}
```

---

### 4.4 服务端回传（示例）

```json
{
  "type": "asr.partial",
  "text": "你好今天"
}
```

```json
{
  "type": "asr.final",
  "text": "你好，今天的天气很好。"
}
```

---

## 5. 非功能性需求

### 5.1 性能

* 端到端延迟（采集 → 服务器接收）：≤ 500ms
* ASR 首次返回：≤ 1s（依赖模型）

### 5.2 稳定性

* 网络抖动 ≤ 2 秒不丢会话
* 支持 ≥ 30 分钟持续音频流

### 5.3 安全

* 所有通信必须使用 HTTPS/WSS
* 不允许前端持有长期有效的服务器密钥
* 支持 Token 过期与刷新

### 5.4 兼容性

* iOS Safari 16+
* 不要求 Android 支持（v1）

---

## 6. 约束与限制

* iOS Safari **必须由用户交互触发**麦克风采集
* 页面切后台可能导致 AudioContext suspend（需监听并恢复）
* 不支持系统级后台录音（非 App）

---

## 7. 里程碑建议

| 阶段 | 内容                      |
| -- | ----------------------- |
| M1 | Web 端麦克风采集 + WS 发送      |
| M2 | Server ingest + 实时打印音频帧 |
| M3 | 接入 ASR + 实时文本回传         |
| M4 | 稳定性 / 断线重连 / 日志         |

---

## 8. 验收标准

* iPhone Safari 打开页面 → 授权麦克风 → 说话
* 服务器在 **1 秒内**收到连续音频帧
* ASR 能实时输出文字
* 网络中断后可恢复同一会话

---

## 9. 后续扩展（不在 v1）

* Opus 编码
* WebRTC 替换 WebSocket
* 多人会话 / 会议模式
* 录音回放

---

# 实现说明与运行

本仓库已经按上述 SRS 完成 Web 端与后端实现：

* Web：`getUserMedia` + `AudioWorklet` 下采样到 16k，生成 PCM16 20ms 帧，经 WebSocket 发送
* Backend：WebSocket 接入、鉴权、帧顺序重排与 WAV 写入
* 断线自动重连（保留 `session_id`）与本地暂停/恢复

## 目录结构

```
web/            # 前端（静态）
server/         # Node.js 后端（静态文件 + WS）
```

## 快速运行（本地）

1) 安装后端依赖：

```
cd server
npm i
```

2) 启动服务（默认 8080）：

```
node src/index.js
```

3) 手机 Safari 访问：

```
http://<你的局域网IP>:8080/
```

> 若需 WSS（生产环境），请通过反向代理（Nginx/Cloudflare）启用 HTTPS/WSS。

## Web 端配置

Web 端通过 URL 参数配置：

* `ws`：WS 地址（可选），例如：`ws=ws://192.168.0.10:8080/ws/audio`
* `token`：鉴权 token（可选，默认 `dev-token-12345`）

示例：

```
http://<你的局域网IP>:8080/?ws=ws://<你的局域网IP>:8080/ws/audio&token=YOUR_TOKEN
```

## 录音输出

每个会话在 `server/recordings/` 生成 WAV 文件。
