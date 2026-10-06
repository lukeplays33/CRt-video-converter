import * as PIXI from 'pixi.js';

import { VideoAudioEncoder } from './js/converters/videoAudioEncoder.js';
import { CRTDecoderRenderer } from './js/converters/CRT_decoder_renderer.js';

const fullscreenBtn = document.getElementById('fullscreen');
const fileUpload = document.getElementById('fileUpload');
const videoConverter = document.getElementById('videoConverter');
const canvasElement = document.getElementById('crt-canvas');
const crt_container = document.getElementById('crt-container');

const offscreenCanvas = document.createElement('canvas');
// Set standard 4:3 offscreen baseline
offscreenCanvas.width = 760;
offscreenCanvas.height = 570;

const curvature_range = document.getElementById('curvature_range');
const zoom_range = document.getElementById('zoom_range');

const crtFragmentShader = `
precision mediump float;

varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform float uCurvature;
uniform vec2 uResolution;

vec2 curveUV(vec2 uv) {
    if (uCurvature <= 0.0) return uv;

    vec2 p = uv - 0.5;

    // Use dynamic resolution uniform to prevent aspect ratio distortion
    float aspect = uResolution.x / uResolution.y;
    p.x *= aspect;

    float r2 = dot(p, p);
    float r = sqrt(r2);

    float bulbDepth = 1.0 - r * 1.25;
    float bulbWarp = 1.0 + uCurvature * 9.0 * r2;

    p *= bulbWarp;
    p *= 1.0 + uCurvature * 0.5 * bulbDepth;
    p *= 1.0 / (1.0 + uCurvature * 0.25);

    p.x /= aspect;
    return p + 0.5;
}

void main(void) {
    vec2 uv = curveUV(vTextureCoord);

    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    vec3 color = texture2D(uSampler, uv).rgb;

    vec2 centerVec = uv - vec2(0.5);
    float bulbDepth = 1.0 - clamp(length(centerVec) * 1.6, 0.0, 1.0);
    color *= mix(0.72, 1.18, bulbDepth);

    vec2 vUV = uv * (1.0 - uv.yx);
    float vignette = vUV.x * vUV.y * 28.0;
    vignette = clamp(pow(vignette, 0.45), 0.0, 1.0);
    color *= vignette;

    vec2 glareUV = vTextureCoord - vec2(0.5, 0.2);
    float glare = max(0.0, 1.0 - length(glareUV) * 2.2);
    color += vec3(0.04) * pow(glare, 2.0);

    gl_FragColor = vec4(color, 1.0);
}
`;

const crtVertexShader = `
    attribute vec2 aVertexPosition;
    attribute vec2 aTextureCoord;
    uniform mat3 projectionMatrix;
    varying vec2 vTextureCoord;

    void main(void) {
        gl_Position = vec4((projectionMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
        vTextureCoord = aTextureCoord;
    }
`;

let targetFPS = 25;
let app;
let sprite;
let baseTexture;
let texture;
let crtShader;
let decoderInstance = null;

function setShaders() {
    if (crtShader && curvature_range) {
        crtShader.uniforms.uCurvature = parseFloat(curvature_range.value || 0.5);
    }
    if (canvasElement && zoom_range) {
        canvasElement.style.transform = `scale(${1 + Number(zoom_range.value || 0)})`;
    }
}

async function initCRT() {
    app = new PIXI.Application({
        view: canvasElement,
        width: 800,
        height: 600,
        backgroundColor: 0x000000,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1
    });

    baseTexture = new PIXI.BaseTexture(offscreenCanvas);
    texture = new PIXI.Texture(baseTexture);

    crtShader = new PIXI.Filter(crtVertexShader, crtFragmentShader, {
        uTime: 0,
        uTargetFPS: targetFPS,
        uResolution: [800, 600],
        uCurvature: curvature_range ? parseFloat(curvature_range.value || 0.5) : 0.5
    });

    sprite = new PIXI.Sprite(texture);
    sprite.filters = [crtShader];
    app.stage.addChild(sprite);

    const startTime = performance.now();

    app.ticker.add(() => {
        const currentTime = (performance.now() - startTime) / 1000.0;
        crtShader.uniforms.uTime = currentTime;

        if (baseTexture) {
            baseTexture.update();
        }
    });

    handle43Resize();
}

function syncCRTTextureToCanvas() {
    if (!baseTexture || !offscreenCanvas) return;

    baseTexture.setSize(offscreenCanvas.width, offscreenCanvas.height);

    if (texture) {
        // Reset texture frame boundaries to match offscreen canvas dimensions
        texture.frame = new PIXI.Rectangle(0, 0, offscreenCanvas.width, offscreenCanvas.height);
    }
}

fileUpload.addEventListener("change", async function (e) {
    const file = e.target.files[0];
    if (!file) return;

    videoConverter.src = URL.createObjectURL(file);
    videoConverter.muted = true;
    videoConverter.playsInline = true;
    videoConverter.preload = 'auto';
    videoConverter.load();

    videoConverter.addEventListener("loadedmetadata", async () => {
        const targetHeight = 570;
        const targetWidth = Math.floor(targetHeight * (4 / 3)); // 760x570 (4:3)

        offscreenCanvas.width = targetWidth;
        offscreenCanvas.height = targetHeight;

        syncCRTTextureToCanvas();
        handle43Resize();

        try {
            await videoConverter.play();
        } catch (error) {
            console.warn('Autoplay muted retry:', error);
            videoConverter.muted = true;
            try {
                await videoConverter.play();
            } catch (retryError) {
                console.error('Video playback failed:', retryError);
            }
        }

        try {
            console.log('[CRT] starting video conversion pipeline');
            const sample_rate = 96000;
            const encoder = new VideoAudioEncoder(sample_rate, 60, targetHeight);
            const { audioBuffer, audioCtx, sampleRate, targetFps, frameWidth, frameHeight, totalFrames } = await encoder.encodeVideoFile(file);

            console.log('[CRT] decoded audio buffer ready, starting CRT renderer');

            if (decoderInstance && decoderInstance.stop) {
                decoderInstance.stop();
            }

            decoderInstance = new CRTDecoderRenderer(offscreenCanvas);
            decoderInstance.startDecoding(audioBuffer, audioCtx, {
                sampleRate,
                targetFps,
                frameWidth,
                frameHeight,
                totalFrames,
                onFrame: () => {
                    syncCRTTextureToCanvas();
                    if (baseTexture) {
                        baseTexture.update();
                    }
                    if (app && app.render) app.render();
                }
            });

            window.__crtTarget = offscreenCanvas;
        } catch (error) {
            console.error('Video conversion failed:', error);
            if (window.alert) {
                window.alert('The selected video could not be converted into CRT audio. Please try another file.');
            }
        }
    }, { once: true });
});

function handle43Resize() {
    if (!app || !crtShader || !crt_container) return;

    const rect = crt_container.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);

    app.renderer.resize(width, height);

    if (sprite) {
        sprite.width = width;
        sprite.height = height;
    }

    crtShader.uniforms.uResolution = [width, height];
}

// Window & Input Event Listeners
window.addEventListener('resize', handle43Resize);
document.addEventListener('fullscreenchange', handle43Resize);

if (fullscreenBtn) {
    fullscreenBtn.addEventListener('click', () => {
        if (!document.fullscreenElement) {
            canvasElement.requestFullscreen().catch(err => {
                console.error(`Error enabling fullscreen: ${err.message}`);
            });
        } else {
            document.exitFullscreen();
        }
    });
}

if (curvature_range) {
    curvature_range.addEventListener('input', (e) => {
        window.localStorage.setItem('curvature_range', e.target.value);
        setShaders();
    });
}

if (zoom_range) {
    zoom_range.addEventListener('input', (e) => {
        window.localStorage.setItem('zoom_range', e.target.value);
        setShaders();
    });
}

window.addEventListener('DOMContentLoaded', () => {
    if (curvature_range && window.localStorage.getItem('curvature_range')) {
        curvature_range.value = window.localStorage.getItem('curvature_range');
    }
    if (zoom_range && window.localStorage.getItem('zoom_range')) {
        zoom_range.value = window.localStorage.getItem('zoom_range');
    }
    initCRT().then(() => setShaders()).catch(console.error);
});