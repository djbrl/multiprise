const { app, BrowserWindow, nativeImage } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const brandDir = path.join(root, 'brand')
const pngDir = path.join(brandDir, 'png')
const buildDir = path.join(root, 'build')
const iconsetDir = path.join(buildDir, 'icon.iconset')

// brand/*.svg are the sources; every PNG below is rendered from them.
const brandPngs = [
  ['icon.svg', 'icon-1024.png', 1024, 1024],
  ['icon.svg', 'icon-512.png', 512, 512],
  ['icon.svg', 'icon-256.png', 256, 256],
  ['icon-dark.svg', 'icon-dark-1024.png', 1024, 1024],
  ['icon-square.svg', 'avatar-1024.png', 1024, 1024],
  ['icon-square.svg', 'apple-touch-icon.png', 180, 180],
  ['icon-flat.svg', 'favicon-32.png', 32, 32],
  ['icon-flat.svg', 'favicon-16.png', 16, 16],
  ['lockup.svg', 'lockup.png', 1200, null],
  ['lockup-white.svg', 'lockup-white.png', 1200, null],
  ['social-card.svg', 'social-card.png', 1280, 640],
  ['social-card-light.svg', 'social-card-light.png', 1280, 640]
]

// Where the rest of the project picks the brand up.
const copies = [
  ['icon.svg', path.join('renderer', 'src', 'assets', 'multiprise-icon.svg')],
  ['icon-flat.svg', path.join('site', 'icon.svg')],
  [path.join('png', 'apple-touch-icon.png'), path.join('site', 'apple-touch-icon.png')],
  [path.join('png', 'social-card.png'), path.join('site', 'og.png')],
  [path.join('png', 'social-card.png'), path.join('.github', 'social-preview.png')]
]

// The one-color mark for the menu bar: macOS tints "Template" images for light and dark menu bars.
const trayIcons = [['trayTemplate.png', 22], ['trayTemplate@2x.png', 44]]

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

function viewBoxSize(svg) {
  const [, , width, height] = svg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number)
  return { width, height }
}

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(brandDir, 'icon.svg'), 'utf8')
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

  fs.mkdirSync(pngDir, { recursive: true })
  for (const [source, name, width, fixedHeight] of brandPngs) {
    const sourceSvg = fs.readFileSync(path.join(brandDir, source), 'utf8')
    const box = viewBoxSize(sourceSvg)
    const height = fixedHeight ?? Math.round(width * box.height / box.width)
    const image = await capture(renderWindow, width, height, pageHtml(sourceSvg, width, height, (mark) => mark), name)
    fs.writeFileSync(path.join(pngDir, name), image.toPNG())
  }

  const mark = fs.readFileSync(path.join(brandDir, 'mark-ink.svg'), 'utf8')
  for (const [name, size] of trayIcons) {
    // Inset to an 18pt glyph, the size of the system's own menu bar icons.
    const inset = size * 2 / 22
    const tray = await capture(renderWindow, size, size, pageHtml(mark, size, size, (content) => `<div style="width:100%;height:100%;padding:${inset}px">${content}</div>`), 'tray')
    fs.writeFileSync(path.join(buildDir, name), tray.toPNG())
  }

  for (const [from, to] of copies) {
    // Branches without the landing page have no site/ folder to refresh.
    if (!fs.existsSync(path.dirname(path.join(root, to)))) continue
    fs.copyFileSync(path.join(brandDir, from), path.join(root, to))
  }
  renderWindow.destroy()
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
