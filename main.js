import * as PIXI from 'pixi.js';

const fullscreenBtn = document.getElementById('fullscreen'); // Update to your button ID

const fileUpload = document.getElementById('fileUpload');
const videoConverter = document.getElementById('videoConverter');
const canvasElement = document.getElementById('crt-canvas');
const crt_container = document.getElementById('crt-container');

const offscreenCanvas = document.createElement('canvas');
const offscreenCtx = offscreenCanvas.getContext('2d');

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

    // Center the UVs around the screen so the warp is based on distance from the center.
    vec2 p = uv - 0.5;

    // Correct for 4:3 aspect before applying the radial warp.
    p.x *= 4.0 / 3.0;

    // Classic CRT tube curvature: strong barrel warp that pushes the edges inward.
    float radiusSquared = dot(p, p);
    float warp = 1.0 + uCurvature * 7.0 * radiusSquared;
    p *= warp;

    // Keep the screen from ballooning while the tube bends in a chunky, old-school way.
    float sizeCompensation = 1.0 / (1.0 + uCurvature * 0.12);
    p *= sizeCompensation;

    // Undo the aspect correction to keep the screen physically proportioned.
    p.x /= 4.0 / 3.0;

    return p + 0.5;
}

void main(void) {
    vec2 uv = curveUV(vTextureCoord);

    // Clip pixels outside the curved glass frame (renders as the black bezel)
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    vec3 color = texture2D(uSampler, uv).rgb;

    // Heavy old-school corner falloff for a CRT tube edge.
    vec2 vUV = uv * (1.0 - uv.yx);
    float vignette = vUV.x * vUV.y * 28.0;
    vignette = clamp(pow(vignette, 0.45), 0.0, 1.0);
    color *= vignette;

    // Soft reflective glow, but keep it subtle and vintage instead of modern glossy.
    vec2 glareUV = vTextureCoord - vec2(0.5, 0.2);
    float glare = max(0.0, 1.0 - length(glareUV) * 2.2);
    color += vec3(0.04) * pow(glare, 2.0);

    gl_FragColor = vec4(color, 1.0);
}
`;

function setShaders() {
        if (crtShader) {
        // Dynamically updates GPU uniform without re-compiling the shader
        crtShader.uniforms.uCurvature = parseFloat(curvature_range.value);
    }

    canvasElement.style.scale = 1 + Number(zoom_range.value);
}

let targetFPS = 25;
let interval = 1000 / targetFPS;

let app;
let sprite;
let baseTexture;
let texture;
let crtShader;

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
        uCurvature: 0.5 // Default slider value
    });

    sprite = new PIXI.Sprite(texture);
    sprite.filters = [crtShader];
    app.stage.addChild(sprite);

    const startTime = performance.now();

    app.ticker.add(() => {
        const currentTime = (performance.now() - startTime) / 1000.0;
        crtShader.uniforms.uTime = currentTime;
    });

    setInterval(() => {
        if (!videoConverter.paused && !videoConverter.ended && videoConverter.readyState >= 2) {
            captureAndPushFrame();
        }
    }, interval);
}

function captureAndPushFrame() {
    if (!offscreenCanvas.width || !offscreenCanvas.height) return;

    offscreenCtx.drawImage(videoConverter, 0, 0, offscreenCanvas.width, offscreenCanvas.height);
    baseTexture.update();

    sprite.width = app.screen.width;
    sprite.height = app.screen.height;
}

window.setVideoFPS = function (newFPS) {
    targetFPS = newFPS;
    interval = 1000 / targetFPS;
    if (crtShader) {
        crtShader.uniforms.uTargetFPS = newFPS;
    }
};

fileUpload.addEventListener("change", function () {
    const file = this.files[0];
    if (!file) return;

    videoConverter.src = URL.createObjectURL(file);

    videoConverter.addEventListener("loadedmetadata", () => {
        // Force offscreen buffer to maintain a 4:3 ratio based on video height
        const targetHeight = videoConverter.videoHeight || 600;
        const targetWidth = Math.floor(targetHeight * (4 / 3));

        offscreenCanvas.width = targetWidth;
        offscreenCanvas.height = targetHeight;

        if (baseTexture) {
            baseTexture.setSize(targetWidth, targetHeight);
        }

        handle43Resize();
        videoConverter.play();
    }, { once: true });
});

initCRT().catch(console.error);

function get43Dimensions(containerWidth, containerHeight) {
    const targetAspect = 4 / 3;
    let width = containerWidth;
    let height = containerWidth / targetAspect;

    if (height > containerHeight) {
        height = containerHeight;
        width = containerHeight * targetAspect;
    }

    return { width: Math.floor(width), height: Math.floor(height) };
}

function handle43Resize() {
    if (!app || !crtShader) return;

    // Get max available bounds
    const parentWidth = document.fullscreenElement ? window.innerWidth : (canvasElement.parentElement.clientWidth || window.innerWidth);
    const parentHeight = document.fullscreenElement ? window.innerHeight : (window.innerHeight * 0.8);

    // Calculate clamped 4:3 dimensions
    const { width, height } = get43Dimensions(parentWidth, parentHeight);

    // Resize PixiJS renderer & viewport
    app.renderer.resize(width, height);

    if (sprite) {
        sprite.width = width;
        sprite.height = height;
    }

    // Pass exact 4:3 resolution to GLSL uniform for accurate scanline scaling
    crtShader.uniforms.uResolution = [width, height];
}

// Attach event listeners
window.addEventListener('resize', handle43Resize);
document.addEventListener('fullscreenchange', handle43Resize);

// Fullscreen Button Event
if (fullscreenBtn) {
    fullscreenBtn.addEventListener('click', () => {
        if (!document.fullscreenElement) {
            canvasElement.requestFullscreen().catch(err => {
                console.error(`Error attempting to enable fullscreen: ${err.message}`);
            });
        } else {
            document.exitFullscreen();
        }
    });
}

curvature_range.onchange = function (e) {
    window.localStorage.setItem('curvature_range', e.target.value);
    setShaders();
}

zoom_range.onchange = function (e) {
    window.localStorage.setItem('zoom_range', e.target.value);
    setShaders();
}

window.onload = function () {
    curvature_range.value = window.localStorage.getItem('curvature_range');
    zoom_range.value = window.localStorage.getItem('zoom_range');
    setShaders();
}