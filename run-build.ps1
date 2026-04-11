$env:PATH = "C:\Users\gerge\ocr-desktop\.tools\node\node-v22.22.2-win-x64;" + $env:PATH
Set-Location "C:\Users\gerge\ocr-desktop"
& "C:\Users\gerge\ocr-desktop\.tools\node\node-v22.22.2-win-x64\node.exe" `
  "C:\Users\gerge\ocr-desktop\.tools\node\node-v22.22.2-win-x64\node_modules\npm\bin\npm-cli.js" `
  run build:installer 2>&1
