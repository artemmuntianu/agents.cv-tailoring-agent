import os
import shutil
import subprocess
from pdf2image import convert_from_path
import config

def find_libreoffice_executable():
    for path in config.LIBREOFFICE_PATHS:
        if os.path.isabs(path) and os.path.isfile(path):
            return path
        found = shutil.which(path)
        if found:
            return found
    return None

def convert_docx_to_pdf(docx_path, pdf_path):
    output_dir = os.path.dirname(pdf_path)
    os.makedirs(output_dir, exist_ok=True)
    
    libreoffice_cmd = find_libreoffice_executable()
    if not libreoffice_cmd:
        print("⚠️ LibreOffice executable not found. Attempting docx2pdf fallback...")
        try:
            from docx2pdf import convert
            convert(docx_path, pdf_path)
            return pdf_path
        except Exception as e:
            print(f"❌ Failed to convert DOCX to PDF: LibreOffice not installed and fallback failed: {e}")
            raise FileNotFoundError("LibreOffice binary not found. Please install LibreOffice or ensure soffice is on PATH.")
            
    cmd = [
        libreoffice_cmd,
        "--headless",
        "--convert-to", "pdf",
        "--outdir", output_dir,
        docx_path
    ]
    
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        print(f"❌ LibreOffice conversion error: {result.stderr}")
        raise RuntimeError(f"LibreOffice failed with exit code {result.returncode}")
        
    generated_pdf = os.path.join(output_dir, os.path.splitext(os.path.basename(docx_path))[0] + ".pdf")
    if generated_pdf != pdf_path and os.path.exists(generated_pdf):
        if os.path.exists(pdf_path):
            os.remove(pdf_path)
        os.rename(generated_pdf, pdf_path)
        
    return pdf_path

def convert_pdf_to_images(pdf_path, output_dir, dpi=config.RENDER_DPI):
    os.makedirs(output_dir, exist_ok=True)
    images = convert_from_path(pdf_path, dpi=dpi, poppler_path=config.POPPLER_PATH)
    image_paths = []
    
    base_name = os.path.splitext(os.path.basename(pdf_path))[0]
    for idx, img in enumerate(images):
        img_path = os.path.join(output_dir, f"{base_name}_page_{idx + 1}.png")
        img.save(img_path, "PNG")
        image_paths.append(img_path)
        
    return image_paths
