//##
//## Description:
//## Copyright 2024. All Rights Reserved.
//## Author: Zhao Ming (zhaomingwork@qq.com)
//##

import { stringify } from "querystring"
import { arrayBuffer } from "stream/consumers"
import Recorder from 'recorder-core'
// 实时播放pcm

export class StreamPlayClient {
  private _queue: ArrayBuffer[] = []    // buffer for received stream data
  private _blobs_received: ArrayBuffer[] = [] // history for received data
  private _blobs_recorded: ArrayBuffer[] = [] // history for recorded data
  private history: any = []
  private _isPlaying: boolean = false

  private _audioCtx: AudioContext = new AudioContext({ latencyHint: 'interactive', sampleRate: 16000 })
  private sampleRate: number = 16000
  private audioindex: number = 0

  private ws_ref: any // websocket 用于从服务器实时接收数据和发反馈消息
  private audio_record_ref: any // 录音对象句柄

  private offset: number = 0
  private turn: number = 0
  private proceed: number = 0
  private proceed_timeline: number = 0
  private interrupted: boolean = false
  private task_started: boolean = false
  private turn_begin_time: number = 0




  constructor() {

    // play audio for received stream
    this.stream_play()

  }
  //  reset play status
  private async reset_progress_status() {
    this.turn += 1

    this.proceed = 0
    this.proceed_timeline = 0.0
    this.turn_begin_time = 0.0
    this.audioindex = 0
  }

  // set websocket reference
  setWs_ref(ws: any) {
    this.ws_ref = ws
  }
  // set audio_record reference
  setAudiorecord(audio_record: any) {
    this.audio_record_ref = audio_record

  }
  // play data in stream way when queue is not empty
  private async stream_play() {

    if (this._queue.length > 0) {
      const buf = this._queue.shift()! // get one chunk of data
      // received b'end' means finish-playing 
      if (buf.byteLength === 3) {
        
        // create blob url from _blobs_recorded
        let record_data = await this.create_buff_url(this._blobs_recorded)
        // clean the _blobs_recorded
        this._blobs_recorded = []
        // create blob url from _blobs_recorded
        let received_data = await this.create_buff_url(this._blobs_received)
        // clean the _blobs_recorded
        this._blobs_received = []
        this.history.push([received_data, "played"])

        let finish_playing_message = this.create_action('finish-playing', 'task-1', {}, {})
        await this.ws_ref?.send(finish_playing_message)
        console.log("一次对话结束",finish_playing_message)


      }
      // play audio 
      await this._playSource(buf)
      // run stream play again
      this.stream_play()

    }
    else {
      // no data will sleep 0.01s
      await this.sleep(0.01)

      this.stream_play()

    }

  }
  // play audio by audio_context
  private async _playSource(buffer: ArrayBuffer) {



    // check buffer length
    if (!buffer || buffer.byteLength == 0 || this.interrupted) {
      console.log("buffer为0或中断状态**********")
      return
    }

    // This gives us the actual array that contains the data
    const audioArrayBuffer = this._audioCtx.createBuffer(
      1,
      buffer.byteLength / 2,
      16000
    )
    const nowBuffering = audioArrayBuffer.getChannelData(0)

    // cover int 16bit data to float
    const unit8array = new Uint8Array(buffer)
    var int16array = new Int16Array(buffer.byteLength / 2)
    int16array = int16array.map((item, index) => unit8array[index * 2] + unit8array[index * 2 + 1] * 256)
 
    for (let i = 0; i < int16array.length; i++) {

      nowBuffering[i] = int16array[i] / 32767
 
    }

    const node = this._audioCtx.createBufferSource()
    node.buffer = audioArrayBuffer;
    // connect the AudioBufferSourceNode to the
    // destination so we can hear the sound
    await node.connect(this._audioCtx.destination);

    let _audioCtx_begin_time = 0
    let time_delay = 0.02 // 每次提前0.02秒，保证播放连贯性
    // async the time between audiocontext and received time 
    if (this.proceed_timeline == 0.0) {
      _audioCtx_begin_time = this._audioCtx.currentTime
      this.turn_begin_time = _audioCtx_begin_time
      this.proceed_timeline = _audioCtx_begin_time

    }
    node.start(this.proceed_timeline)

   // 记录已经播放的时长
    this.proceed_timeline = this.proceed_timeline + audioArrayBuffer.duration
    // 睡眠（播放时长-0.02秒），达到同步效果 
    await this.sleep(audioArrayBuffer.duration - time_delay)
 
    this.proceed = this.proceed + 1
    let playing_progress_message = this.create_action('playing-progress', 'task-1', {}, {})
     

    setTimeout(() => {
      //  send progress message to websocket server
      this.ws_ref?.send(playing_progress_message)

    }, time_delay * 1000);


    return

  }
  // callback function for recording data
  async on_record_data(data: Int16Array) {
 

    const unit8array = new Uint8Array(data.buffer)
 
    this._blobs_recorded.push(unit8array)
  }
  // 模拟异步睡眠函数async sleep function
  async sleep(i: number): Promise<any> {
    return new Promise((res, rej) => {
      setTimeout(() => {
        res(i * 1000)
      }, i * 1000);
    })
  }


  
  async concatenate(arrays: ArrayBuffer[]) {
    // Calculate byteSize from all arrays
    let size = arrays.reduce((a, b) => a + b.byteLength, 0)
    // need odd 
    if (size % 2 != 0) size = size + 1
    // Allcolate a new buffer
    let result = new Uint8Array(size)

    // Build the new array
    let offset = 0
    for (let arr of arrays) {
      result.set(new Uint8Array(arr), offset)
      offset += arr.byteLength
 
    }

    return result
  }
  async create_buff_url(blogs: ArrayBuffer[]) {

    let concatenate_data = await this.concatenate(blogs)

    //  raw data to wav, add wav header
    let pcm_result = new Promise((resolve, reject) => {
      Recorder.pcm2wav(
        { sampleRate: 16000, bitRate: 16, blob: concatenate_data.buffer },
        (newBlob: Blob) => {
          blogs = []
          const tmpblob = new Blob([newBlob], { type: "audio/wav" });
          const blobUrl = URL.createObjectURL(tmpblob)

          resolve(blobUrl)

        }
      )
    })
    return await pcm_result

  }
  async clean() {
    this._audioCtx.close()
    this._queue = []
 
    this._isPlaying = false
    this._audioCtx = new AudioContext()
    this.interrupted = false
    this.audioindex = 0


    this.reset_progress_status()


  }


  create_action(action: string, task_id: string, input: {}, parameters: {}) {
    const header = {
      'action': action,
      'taskId': task_id
    }
    const payload = {
      'parameters': parameters,
      'input': input
    }
    return {
      'header': header,
      'payload': payload
    }
  }
  async handle_interrupted() {

    this.interrupted = true
    this._queue = []
  }
  // when websocket received data, then add to buffer
  async websocket_callback(blob: Blob) {

    if (!this.interrupted) {


      const buffer = await blob.arrayBuffer()
      this._blobs_received.push(buffer)

      this._queue.push(buffer)
    }


  }


}
