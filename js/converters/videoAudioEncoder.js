export class VideoAudioEncoder {
  constructor(sampleRate = 96000, targetFps = 60, lineRes = 120) {
    this.sampleRate = sampleRate;
    this.targetFps = targetFps;
    this.lineRes = lineRes; // Number of horizontal scanlines
  }

  // Calculate default frameWidth dynamically to guarantee a 4:3 aspect ratio (760x570)
  async encodeVideoFile(file, frameHeight = 570, frameWidth = Math.floor(frameHeight * (4 / 3))) {
    console.log('[CRT] starting encode for file:', file.name, file.size);

    // 1) Load the uploaded video and wait for metadata.
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.src = URL.createObjectURL(file);
    video.load();

    await new Promise((resolve, reject) => {
      video.onloadedmetadata = () => {
        console.log('[CRT] metadata loaded:', video.duration, 's');
        resolve();
      };
      video.onerror = () => reject(new Error('Video metadata could not be loaded.'));
    });

    // 2) Keep the encoder and decoder on the same size so each reconstructed frame matches the CRT raster.
    const effectiveFps = Math.min(this.targetFps, 6);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    canvas.width = frameWidth;
    canvas.height = frameHeight;

    const duration = video.duration;
    const totalFrames = Math.max(1, Math.floor(duration * effectiveFps));
    const pixelsPerFrame = frameWidth * frameHeight;
    const totalSamples = totalFrames * pixelsPerFrame;

    console.log('[CRT] converting frames:', { totalFrames, effectiveFps, frameWidth, frameHeight, duration });

    // 3) Create a stereo buffer. Each sample stores one pixel's brightness and color signal.
    //    The left channel is the luminance (Y), the right channel is a simple chroma value.
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = audioCtx.createBuffer(2, totalSamples, this.sampleRate);
    const leftChannel = audioBuffer.getChannelData(0);
    const rightChannel = audioBuffer.getChannelData(1);

    let sampleOffset = 0;

    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
      const progress = (frameIndex / totalFrames) * 100;
      if (frameIndex % 5 === 0 || frameIndex === totalFrames - 1) {
        console.log(`[CRT] encode progress: ${progress.toFixed(1)}% (${frameIndex}/${totalFrames})`);
      }

      // Move the hidden video to the frame we want to encode.
      video.currentTime = Math.min(frameIndex / effectiveFps, duration - 0.05);
      await new Promise(r => video.onseeked = r);

      ctx.drawImage(video, 0, 0, frameWidth, frameHeight);
      const imgData = ctx.getImageData(0, 0, frameWidth, frameHeight).data;

      // Encode each pixel into one sample.
      for (let y = 0; y < frameHeight; y++) {
        for (let x = 0; x < frameWidth; x++) {
          const i = (y * frameWidth + x) * 4;
          const r = imgData[i] / 255;
          const g = imgData[i + 1] / 255;
          const b = imgData[i + 2] / 255;

          // Convert RGB to luminance and a basic red-blue chroma signal.
          const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
          const chrominance = (r - b) * 0.5;

          leftChannel[sampleOffset] = luminance * 2 - 1;
          rightChannel[sampleOffset] = chrominance * 2 - 1;
          sampleOffset++;
        }
      }
    }

    console.log('[CRT] encode complete');

    return {
      audioBuffer,
      audioCtx,
      sampleRate: this.sampleRate,
      targetFps: effectiveFps,
      frameWidth,
      frameHeight,
      totalFrames
    };
  }
}