// A GPU-to-CPU read with one sync point instead of two.
//
// In Chrome every glGet is a round trip to the GPU process, which first works
// through the whole queued command stream. three's readRenderTargetPixelsAsync
// makes two: a getParameter(IMPLEMENTATION_COLOR_READ_TYPE) to check any type
// but bytes is readable, on the frame the read is issued, and getBufferSubData
// once the fence has signalled. Uncapped on an M4 (manhattan-cruise, 1280x720)
// the sky probe's refresh, the only caller, cost 350 ms on one frame and 276 ms
// nine frames later, every 45 frames.
//
// Here the caller states format and type, so the first goes. The second
// cannot: getBufferSubData blocked for 300 ms even after the fence status had
// come back signalled, so it is a round trip whatever the fence says, and the
// sky probe asks for it rarely (see MAX_FRAMES there).

export class AsyncReadback {
  private buffer: WebGLBuffer | null = null;
  private sync: WebGLSync | null = null;

  constructor(private readonly gl: WebGL2RenderingContext, private readonly bytes: number) {}

  /** A read is in flight. */
  get busy(): boolean {
    return this.sync !== null;
  }

  /**
   * Queue a read of the currently bound framebuffer. The caller binds it
   * (renderer.setRenderTarget) and states format and type, which is exactly
   * what the getParameter round trip was finding out.
   */
  start(x: number, y: number, w: number, h: number, format: number, type: number): boolean {
    const gl = this.gl;
    if (this.sync) return false;
    if (!this.buffer) {
      this.buffer = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buffer);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, this.bytes, gl.STREAM_READ);
    } else {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buffer);
    }
    gl.readPixels(x, y, w, h, format, type, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    return true;
  }

  /** Copy the result into `dst` and return true once it is ready; never waits. */
  poll(dst: ArrayBufferView): boolean {
    const gl = this.gl;
    if (!this.sync) return false;
    if (gl.getSyncParameter(this.sync, gl.SYNC_STATUS) !== gl.SIGNALED) return false;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buffer);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, dst);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.deleteSync(this.sync);
    this.sync = null;
    return true;
  }
}
