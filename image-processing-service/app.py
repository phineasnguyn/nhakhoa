"""
Image Processing Service API
FastAPI server cho xử lý ảnh nha khoa
"""
from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from typing import List, Optional
import os
import shutil
import tempfile
import zipfile
from pathlib import Path
import cv2
import numpy as np

from config import Config
from processors import ToothDivider, DataAugmenter
from utils.yolo_helper import read_yolo_annotation
from processors.overlay_geometry import compute_overlay

# Khởi tạo FastAPI app
app = FastAPI(
    title="Image Processing Service",
    description="Service xử lý ảnh nha khoa: cắt 4 góc răng và data augmentation",
    version="1.0.0"
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=Config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Khởi tạo processors
tooth_divider = ToothDivider(
    bracket_class=Config.BRACKET_CLASS,
    padding_px=Config.PADDING_PX
)
data_augmenter = DataAugmenter()


@app.post('/api/process/overlay-metadata')
async def overlay_metadata(payload: dict):
    try:
        return compute_overlay(payload)
    except (ValueError, TypeError, KeyError) as error:
        raise HTTPException(status_code=422, detail=str(error))


@app.get("/")
async def root():
    """Root endpoint"""
    return {
        "service": "Image Processing Service",
        "version": "1.0.0",
        "status": "running"
    }


@app.get("/api/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "service": "image-processing-service"
    }


@app.post("/api/process/divide-corners")
async def divide_corners(
    images: List[UploadFile] = File(...),
    annotations: List[UploadFile] = File(...)
):
    """
    Xử lý ảnh: cắt 4 góc răng dựa trên bounding box răng và mắc cài
    
    Args:
        images: danh sách file ảnh (9 ảnh)
        annotations: danh sách file annotation tương ứng (9 file .txt)
    
    Returns:
        ZIP file chứa ảnh và annotations đã xử lý
    """
    if len(images) != len(annotations):
        raise HTTPException(
            status_code=400,
            detail=f"Số lượng ảnh ({len(images)}) và annotations ({len(annotations)}) không khớp"
        )
    
    # Tạo thư mục tạm
    with tempfile.TemporaryDirectory() as temp_dir:
        input_img_dir = os.path.join(temp_dir, "input_images")
        input_ann_dir = os.path.join(temp_dir, "input_annotations")
        output_img_dir = os.path.join(temp_dir, "output_images")
        output_ann_dir = os.path.join(temp_dir, "output_annotations")
        
        os.makedirs(input_img_dir, exist_ok=True)
        os.makedirs(input_ann_dir, exist_ok=True)
        
        try:
            # Lưu file upload
            for img_file in images:
                img_path = os.path.join(input_img_dir, img_file.filename)
                with open(img_path, "wb") as f:
                    shutil.copyfileobj(img_file.file, f)
            
            for ann_file in annotations:
                ann_path = os.path.join(input_ann_dir, ann_file.filename)
                with open(ann_path, "wb") as f:
                    shutil.copyfileobj(ann_file.file, f)
            
            # Xử lý batch
            stats = tooth_divider.process_batch(
                input_img_dir,
                input_ann_dir,
                output_img_dir,
                output_ann_dir
            )
            
            # Tạo ZIP file
            zip_path = os.path.join(temp_dir, "processed_results.zip")
            with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
                # Thêm ảnh
                for img_file in os.listdir(output_img_dir):
                    img_path = os.path.join(output_img_dir, img_file)
                    zipf.write(img_path, f"images/{img_file}")
                
                # Thêm annotations
                for ann_file in os.listdir(output_ann_dir):
                    ann_path = os.path.join(output_ann_dir, ann_file)
                    zipf.write(ann_path, f"annotations/{ann_file}")
            
            # Đọc ZIP file vào memory
            with open(zip_path, 'rb') as f:
                zip_content = f.read()
            
            # Trả về response
            return JSONResponse(
                content={
                    "success": True,
                    "stats": stats,
                    "message": "Xử lý thành công"
                },
                headers={
                    "X-Processing-Stats": str(stats)
                }
            )
            
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Lỗi khi xử lý: {str(e)}"
            )


@app.post("/api/process/divide-corners-batch")
async def divide_corners_batch(
    images: List[UploadFile] = File(...),
    annotations: List[UploadFile] = File(...)
):
    """
    Xử lý batch và trả về ZIP file chứa kết quả
    
    Args:
        images: danh sách file ảnh
        annotations: danh sách file annotation tương ứng
    
    Returns:
        ZIP file để download
    """
    if len(images) != len(annotations):
        raise HTTPException(
            status_code=400,
            detail=f"Số lượng ảnh ({len(images)}) và annotations ({len(annotations)}) không khớp"
        )
    
    # Tạo thư mục tạm
    temp_dir = tempfile.mkdtemp()
    input_img_dir = os.path.join(temp_dir, "input_images")
    input_ann_dir = os.path.join(temp_dir, "input_annotations")
    output_img_dir = os.path.join(temp_dir, "output_images")
    output_ann_dir = os.path.join(temp_dir, "output_annotations")
    
    os.makedirs(input_img_dir, exist_ok=True)
    os.makedirs(input_ann_dir, exist_ok=True)
    
    try:
        # Lưu file upload
        for img_file in images:
            img_path = os.path.join(input_img_dir, img_file.filename)
            with open(img_path, "wb") as f:
                shutil.copyfileobj(img_file.file, f)
        
        for ann_file in annotations:
            ann_path = os.path.join(input_ann_dir, ann_file.filename)
            with open(ann_path, "wb") as f:
                shutil.copyfileobj(ann_file.file, f)
        
        # Xử lý batch
        stats = tooth_divider.process_batch(
            input_img_dir,
            input_ann_dir,
            output_img_dir,
            output_ann_dir
        )
        
        # Tạo ZIP file
        zip_path = os.path.join(temp_dir, "processed_results.zip")
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            # Thêm ảnh
            for img_file in os.listdir(output_img_dir):
                img_path = os.path.join(output_img_dir, img_file)
                zipf.write(img_path, f"images/{img_file}")
            
            # Thêm annotations
            for ann_file in os.listdir(output_ann_dir):
                ann_path = os.path.join(output_ann_dir, ann_file)
                zipf.write(ann_path, f"annotations/{ann_file}")
        
        # Trả về ZIP file
        return FileResponse(
            zip_path,
            media_type="application/zip",
            filename="processed_results.zip",
            background=None  # Không xóa file ngay, để cleanup sau
        )
        
    except Exception as e:
        # Cleanup
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi khi xử lý: {str(e)}"
        )


@app.post("/api/process/augment")
async def augment_dataset(
    images: List[UploadFile] = File(...),
    annotations: List[UploadFile] = File(...),
    augmentations: Optional[str] = Form(None),
    create_subfolders: bool = Form(True)
):
    """
    Thực hiện data augmentation
    
    Args:
        images: danh sách file ảnh
        annotations: danh sách file annotation tương ứng
        augmentations: danh sách augmentations (comma-separated), None = all
        create_subfolders: tạo subfolder cho mỗi ảnh hay không
    
    Returns:
        ZIP file chứa ảnh và annotations đã augment
    """
    if len(images) != len(annotations):
        raise HTTPException(
            status_code=400,
            detail=f"Số lượng ảnh ({len(images)}) và annotations ({len(annotations)}) không khớp"
        )
    
    # Parse augmentations
    aug_list = None
    if augmentations:
        aug_list = [a.strip() for a in augmentations.split(',')]
        # Validate
        invalid = [a for a in aug_list if a not in DataAugmenter.AUGMENTATIONS]
        if invalid:
            raise HTTPException(
                status_code=400,
                detail=f"Augmentations không hợp lệ: {invalid}"
            )
    
    # Tạo thư mục tạm
    temp_dir = tempfile.mkdtemp()
    input_img_dir = os.path.join(temp_dir, "input_images")
    input_ann_dir = os.path.join(temp_dir, "input_annotations")
    output_img_dir = os.path.join(temp_dir, "output_images")
    output_ann_dir = os.path.join(temp_dir, "output_annotations")
    
    os.makedirs(input_img_dir, exist_ok=True)
    os.makedirs(input_ann_dir, exist_ok=True)
    
    try:
        # Lưu file upload
        for img_file in images:
            img_path = os.path.join(input_img_dir, img_file.filename)
            with open(img_path, "wb") as f:
                shutil.copyfileobj(img_file.file, f)
        
        for ann_file in annotations:
            ann_path = os.path.join(input_ann_dir, ann_file.filename)
            with open(ann_path, "wb") as f:
                shutil.copyfileobj(ann_file.file, f)
        
        # Xử lý augmentation
        stats = data_augmenter.augment_dataset(
            input_img_dir,
            input_ann_dir,
            output_img_dir,
            output_ann_dir,
            augmentations=aug_list,
            create_subfolders=create_subfolders
        )
        
        # Tạo ZIP file
        zip_path = os.path.join(temp_dir, "augmented_results.zip")
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            # Thêm tất cả files (có thể có subfolders)
            for root, dirs, files in os.walk(output_img_dir):
                for file in files:
                    file_path = os.path.join(root, file)
                    arcname = os.path.relpath(file_path, output_img_dir)
                    zipf.write(file_path, f"images/{arcname}")
            
            for root, dirs, files in os.walk(output_ann_dir):
                for file in files:
                    file_path = os.path.join(root, file)
                    arcname = os.path.relpath(file_path, output_ann_dir)
                    zipf.write(file_path, f"annotations/{arcname}")
        
        # Trả về ZIP file
        return FileResponse(
            zip_path,
            media_type="application/zip",
            filename="augmented_results.zip",
            background=None
        )
        
    except Exception as e:
        # Cleanup
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi khi augment: {str(e)}"
        )


@app.get("/api/augmentations")
async def get_available_augmentations():
    """Lấy danh sách augmentations có sẵn"""
    return {
        "augmentations": DataAugmenter.AUGMENTATIONS,
        "descriptions": {
            "rotate_left": "Xoay trái 15 độ",
            "rotate_right": "Xoay phải 15 độ",
            "flip": "Lật ngang",
            "brightness_up": "Tăng độ sáng 20%",
            "brightness_down": "Giảm độ sáng 20%"
        }
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app:app",
        host=Config.HOST,
        port=Config.PORT,
        reload=Config.DEBUG
    )
