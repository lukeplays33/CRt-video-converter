export class CRTDecoderRenderer {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.currentX = 0;
    this.currentY = 0;
    this.lineHeight = Math.max(1, canvasElement.height / 120);
    this.animationId = null;
    this.source = null;
    this.analyser = null;
    this.audioCtx = null;
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  stop() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    if (this.source) {
      try {
        this.source.stop();
      } catch {
        // Source may already be stopped.
      }
      this.source.disconnect();
      this.source = null;
    }

    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close().catch(() => {});
    }
  }

  startDecoding(audioBuffer, audioCtx, options = {}) {
    this.stop();

    // The encoder now stores one pixel per sample. That means we can decode frame-by-frame.
    const targetFps = options.targetFps ?? 60;
    const frameWidth = options.frameWidth ?? 573;
    const frameHeight = options.frameHeight ?? 570;
    const totalFrames = options.totalFrames ?? Math.max(1, Math.floor(audioBuffer.length / (frameWidth * frameHeight)));
    const pixelsPerFrame = frameWidth * frameHeight;

    const leftChannel = audioBuffer.getChannelData(0);
    const rightChannel = audioBuffer.getChannelData(1);

    // Reset the canvas to black before animation starts.
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const clamp = (value) => Math.max(0, Math.min(255, value));
    let frameIndex = 0;
    let lastTimestamp = 0;
    const onFrame = options.onFrame ?? null;

    // This is the key fix: instead of drawing one static reconstruction, we redraw the canvas
    // every frame based on the current time slice of the encoded waveform.
    const renderFrame = (timestamp) => {
      if (!lastTimestamp) lastTimestamp = timestamp;
      const elapsedSeconds = (timestamp - lastTimestamp) / 1000;
      const frameDuration = 1 / targetFps;

      if (elapsedSeconds >= frameDuration) {
        lastTimestamp = timestamp;
        frameIndex = (frameIndex + 1) % totalFrames;
      }

      const frameOffset = frameIndex * pixelsPerFrame;
      const imageData = this.ctx.createImageData(frameWidth, frameHeight);

      for (let y = 0; y < frameHeight; y++) {
        for (let x = 0; x < frameWidth; x++) {
          const pixelIndex = y * frameWidth + x;
          const sampleIndex = frameOffset + pixelIndex;

          const luminance = (leftChannel[sampleIndex] + 1) / 2;
          const chrominance = (rightChannel[sampleIndex] + 1) / 2;

          // Reconstruct an approximate RGB color from the Y/C values.
          const r = clamp((luminance + chrominance * 1.2) * 255);
          const g = clamp((luminance + chrominance * 0.2) * 255);
          const b = clamp((luminance - chrominance * 1.2) * 255);

          const pixelPos = (y * frameWidth + x) * 4;
          imageData.data[pixelPos] = r;
          imageData.data[pixelPos + 1] = g;
          imageData.data[pixelPos + 2] = b;
          imageData.data[pixelPos + 3] = 255;
        }
      }

      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.putImageData(imageData, 0, 0);

      if (onFrame) onFrame({ frameIndex, frameWidth, frameHeight });

      this.animationId = requestAnimationFrame(renderFrame);
    };

    this.audioCtx = audioCtx;
    const source = audioCtx.createBufferSource();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.1;

    const lowPass = audioCtx.createBiquadFilter();
    lowPass.type = 'lowpass';
    lowPass.frequency.value = 18000;

    source.connect(lowPass);
    lowPass.connect(analyser);
    analyser.connect(audioCtx.destination);

    source.buffer = audioBuffer;
    source.start();
    this.source = source;
    this.analyser = analyser;

    this.animationId = requestAnimationFrame(renderFrame);
  }
}