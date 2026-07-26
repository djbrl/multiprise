const { app, BrowserWindow, nativeImage } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const sourcePath = path.join(root, 'renderer', 'src', 'assets', 'multiprise-icon.svg')
const buildDir = path.join(root, 'build')
const iconsetDir = path.join(buildDir, 'icon.iconset')
const socialPath = path.join(root, '.github', 'social-preview.png')

const iconFiles = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024]
]

function pageHtml(svg, width, height, content) {
  return `<!doctype html><html><head><style>
    html,body{width:${width}px;height:${height}px;margin:0;overflow:hidden;background:transparent}
    *{box-sizing:border-box}
    svg{display:block;width:100%;height:100%}
  </style></head><body>${content(svg)}</body></html>`
}

async function capture(window, width, height, html, name) {
  const renderPath = path.join(buildDir, `.icon-render-${name}.html`)
  fs.writeFileSync(renderPath, html)
  window.setContentSize(width, height)
  await window.loadFile(renderPath)
  const image = await window.webContents.capturePage({ x: 0, y: 0, width, height })
  fs.rmSync(renderPath, { force: true })
  return image.resize({ width, height, quality: 'best' })
}

app.whenReady().then(async () => {
  const svg = fs.readFileSync(sourcePath, 'utf8')
  fs.mkdirSync(buildDir, { recursive: true })
  const renderWindow = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    width: 1024,
    height: 1024,
    useContentSize: true,
    webPreferences: { sandbox: true }
  })
  fs.rmSync(iconsetDir, { recursive: true, force: true })
  fs.mkdirSync(iconsetDir, { recursive: true })

  const master = await capture(renderWindow, 1024, 1024, pageHtml(svg, 1024, 1024, (mark) => mark), 'app')
  const masterPng = master.toPNG()
  fs.writeFileSync(path.join(buildDir, 'icon.png'), masterPng)
  const sourceImage = nativeImage.createFromBuffer(masterPng)
  for (const [name, size] of iconFiles) {
    const resized = sourceImage.resize({ width: size, height: size, quality: 'best' })
    fs.writeFileSync(path.join(iconsetDir, name), resized.toPNG())
  }
  execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', path.join(buildDir, 'icon.icns')])
  fs.rmSync(iconsetDir, { recursive: true, force: true })

  const social = await capture(renderWindow, 1280, 640, pageHtml(svg, 1280, 640, (mark) => `
    <main style="width:1280px;height:640px;display:flex;align-items:center;justify-content:center;gap:58px;background:#1C1C1C;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
      <div style="width:224px;height:224px">${mark}</div>
      <div style="color:#FAFAFA">
        <div style="font-size:76px;font-weight:700;letter-spacing:-4px;line-height:1">multiprise</div>
        <div style="margin-top:20px;color:#A3A3A3;font-size:27px;letter-spacing:-.5px">Run every local project from one place.</div>
      </div>
    </main>`), 'social')
  fs.writeFileSync(socialPath, social.toPNG())
  renderWindow.destroy()
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
