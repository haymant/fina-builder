import { spawn } from 'node:child_process'

const playwrightArgs = process.argv.slice(2)
const selectedArgs = playwrightArgs.length > 0 ? playwrightArgs : ['--grep', '@demo']
const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx'

const child = spawn(executable, ['playwright', 'test', ...selectedArgs], {
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_VIDEO: 'on' },
})

child.on('error', (error) => {
  console.error(`Unable to start Playwright: ${error.message}`)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.exitCode = 1
    return
  }
  process.exitCode = code ?? 1
})
