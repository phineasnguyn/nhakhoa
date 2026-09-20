import { useState } from 'react';

// The bitmap is its own DOM layer; changing a label/hover only redraws vectors.
// SVG's viewBox uses source pixels and shares object-fit:contain alignment.
export default function AnnotationCanvas({
  imageUrl, teeth = [], imageWidth, imageHeight, onSubboxClick, onImageClick,
}) {
  const [natural, setNatural] = useState(null);
  const [hovered, setHovered] = useState(null);
  const [failed, setFailed] = useState(false);
  const width = imageWidth || natural?.width;
  const height = imageHeight || natural?.height;
  const valid = bbox => Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite);
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 0 }}
      onClick={onImageClick}>
      <img src={imageUrl} alt="Ảnh nha khoa"
        onLoad={event => { setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); setFailed(false); }}
        onError={() => setFailed(true)}
        style={{ display: 'block', width: '100%', height: '100%', objectFit: 'contain' }} />
      {failed && <span role="alert">Không thể tải ảnh</span>}
      {width > 0 && height > 0 && !failed && (
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet"
          aria-label="Khung răng, mắc cài và vùng đánh giá"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
          {teeth.map(tooth => valid(tooth.bbox) && (
            <g key={tooth.annotation_id}>
              <rect x={tooth.bbox[0]} y={tooth.bbox[1]} width={tooth.bbox[2]} height={tooth.bbox[3]}
                fill="none" stroke={tooth.kind === 'bracket' || tooth.category_id === 21 ? '#f59e0b' : '#10b981'}
                strokeWidth="2" vectorEffect="non-scaling-stroke" />
              {(tooth.subboxes || []).map(subbox => valid(subbox.bbox) && (
                <rect key={subbox.subbox_id} x={subbox.bbox[0]} y={subbox.bbox[1]}
                  width={subbox.bbox[2]} height={subbox.bbox[3]}
                  fill={subbox.plaque_status === 1 ? '#ef4444' : subbox.plaque_status === 0 ? '#10b981' : '#94a3b8'}
                  fillOpacity={hovered === subbox.subbox_id ? .4 : .18}
                  stroke={hovered === subbox.subbox_id ? '#facc15' : subbox.plaque_status === 1 ? '#ef4444' : '#10b981'}
                  strokeWidth={hovered === subbox.subbox_id ? 3 : 1.5} vectorEffect="non-scaling-stroke"
                  style={{ pointerEvents: onSubboxClick ? 'all' : 'none', cursor: onSubboxClick ? 'pointer' : 'default' }}
                  onMouseEnter={() => setHovered(subbox.subbox_id)} onMouseLeave={() => setHovered(null)}
                  onClick={event => { if (onSubboxClick) { event.stopPropagation(); onSubboxClick(subbox, tooth); } }}>
                  <title>{`${tooth.category_name} · ${subbox.region} · ${subbox.plaque_status === 1 ? 'Có mảng bám' : subbox.plaque_status === 0 ? 'Không có mảng bám' : 'Chưa đánh giá'}`}</title>
                </rect>
              ))}
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}
