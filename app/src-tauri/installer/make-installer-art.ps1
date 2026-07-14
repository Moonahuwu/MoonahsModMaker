# Generates the NSIS installer art (sidebar.bmp 164x314, header.bmp 150x57)
# from icons/icon.png in the app's dark theme (#09090b bg, mint #a7fff1 accent,
# section colors mint/orange/violet/sky). Re-run after changing the app icon:
#   powershell -ExecutionPolicy Bypass -File make-installer-art.ps1
# NSIS wants 24-bit BMPs; both images are composed on Format24bppRgb bitmaps.

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$iconPath = Join-Path $here "..\icons\icon.png"
$icon = [System.Drawing.Image]::FromFile((Resolve-Path $iconPath))

$bgTop = [System.Drawing.Color]::FromArgb(9, 9, 11)        # #09090b (app bg)
$bgBottom = [System.Drawing.Color]::FromArgb(13, 26, 23)   # mint-tinted dark
$white = [System.Drawing.Color]::FromArgb(250, 250, 250)   # zinc-50
$dim = [System.Drawing.Color]::FromArgb(161, 161, 170)     # zinc-400
$mint = [System.Drawing.Color]::FromArgb(167, 255, 241)    # #a7fff1
$sectionColors = @(
    $mint,
    [System.Drawing.Color]::FromArgb(251, 146, 60),        # orange-400 (Items)
    [System.Drawing.Color]::FromArgb(167, 139, 250),       # violet-400 (Wall Art)
    [System.Drawing.Color]::FromArgb(56, 189, 248)         # sky-400 (Sounds)
)

function New-Canvas([int]$w, [int]$h) {
    $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    ,@($bmp, $g)
}

# ---- Sidebar (welcome/finish pages), 164x314 ----
$c = New-Canvas 164 314; $bmp = $c[0]; $g = $c[1]
$rect = New-Object System.Drawing.Rectangle(0, 0, 164, 314)
$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $bgTop, $bgBottom, 90.0)
$g.FillRectangle($grad, $rect)

# Mint accent stripe down the left edge.
$g.FillRectangle((New-Object System.Drawing.SolidBrush($mint)), 0, 0, 3, 314)

# App icon, centered in the upper half.
$g.DrawImage($icon, 34, 42, 96, 96)

# Wordmark.
$center = New-Object System.Drawing.StringFormat
$center.Alignment = [System.Drawing.StringAlignment]::Center
$fCaps = New-Object System.Drawing.Font("Segoe UI", 8.5, [System.Drawing.FontStyle]::Regular)
$fName = New-Object System.Drawing.Font("Segoe UI Semibold", 15, [System.Drawing.FontStyle]::Bold)
$fSub = New-Object System.Drawing.Font("Segoe UI", 8, [System.Drawing.FontStyle]::Regular)
$brWhite = New-Object System.Drawing.SolidBrush($white)
$brDim = New-Object System.Drawing.SolidBrush($dim)
$g.DrawString("M O O N A H S", $fCaps, $brDim, (New-Object System.Drawing.RectangleF(0, 156, 164, 16)), $center)
$g.DrawString("Mod Maker", $fName, $brWhite, (New-Object System.Drawing.RectangleF(0, 172, 164, 30)), $center)

# Mint underline beneath the wordmark.
$g.FillRectangle((New-Object System.Drawing.SolidBrush($mint)), 62, 208, 40, 2)

$g.DrawString("for Deadlock", $fSub, $brDim, (New-Object System.Drawing.RectangleF(0, 218, 164, 14)), $center)

# The four sidebar-section colors as dots near the bottom.
$dotY = 284; $dotR = 6; $gap = 16
$startX = [int](164 / 2 - ((3 * $gap) + $dotR) / 2)
for ($i = 0; $i -lt 4; $i++) {
    $br = New-Object System.Drawing.SolidBrush($sectionColors[$i])
    $g.FillEllipse($br, $startX + $i * $gap, $dotY, $dotR, $dotR)
}

$g.Dispose()
$bmp.Save((Join-Path $here "sidebar.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
$bmp.Dispose()

# ---- Header (all other pages), 150x57 ----
$c = New-Canvas 150 57; $bmp = $c[0]; $g = $c[1]
$rect = New-Object System.Drawing.Rectangle(0, 0, 150, 57)
$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $bgTop, $bgBottom, 0.0)
$g.FillRectangle($grad, $rect)
$g.DrawImage($icon, 12, 7, 40, 40)
$fHdr = New-Object System.Drawing.Font("Segoe UI Semibold", 9, [System.Drawing.FontStyle]::Bold)
$g.DrawString("Moonahs", $fHdr, (New-Object System.Drawing.SolidBrush($white)), 58, 12)
$g.DrawString("Mod Maker", $fHdr, (New-Object System.Drawing.SolidBrush($white)), 58, 27)
$g.FillRectangle((New-Object System.Drawing.SolidBrush($mint)), 0, 55, 150, 2)
$g.Dispose()
$bmp.Save((Join-Path $here "header.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
$bmp.Dispose()

$icon.Dispose()
Write-Host "Wrote sidebar.bmp (164x314) + header.bmp (150x57) to $here"
