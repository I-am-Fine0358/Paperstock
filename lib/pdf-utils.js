const fs = require('fs');
const path = require('path');

/**
 * Extract cover image from a PDF's first page using macOS qlmanage.
 */
async function extractCover(pdfPath, outputDir, bookId) {
    const outputPath = path.join(outputDir, `cover_${bookId}.png`);

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    try {
        const { execSync } = require('child_process');
        const tmpDir = path.join(outputDir, '.tmp_' + bookId);
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

        execSync(`qlmanage -t -s 600 -o "${tmpDir}" "${pdfPath}"`, {
            timeout: 15000,
            stdio: 'pipe'
        });

        const files = fs.readdirSync(tmpDir);
        const thumb = files.find(f => f.endsWith('.png'));
        if (thumb) {
            fs.copyFileSync(path.join(tmpDir, thumb), outputPath);
            for (const f of files) fs.unlinkSync(path.join(tmpDir, f));
            try { fs.rmdirSync(tmpDir); } catch (e) { /* ignore */ }
            return outputPath;
        }
    } catch (e) {
        console.warn('qlmanage thumbnail failed:', e.message);
    }

    return null;
}

async function getPdfPageCount(pdfPath) {
    try {
        const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const data = new Uint8Array(fs.readFileSync(pdfPath));
        const doc = await pdfjsLib.getDocument({ data }).promise;
        const count = doc.numPages;
        doc.destroy();
        return count;
    } catch (e) {
        console.warn('Failed to get page count:', e.message);
        // Fallback: try to read page count from PDF header
        try {
            const content = fs.readFileSync(pdfPath, 'latin1');
            const match = content.match(/\/Type\s*\/Page[^s]/g);
            return match ? match.length : 0;
        } catch (e2) {
            return 0;
        }
    }
}

module.exports = { extractCover, getPdfPageCount };
