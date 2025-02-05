"use strict";

// Получаем элементы страницы
const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('dropZone');
const canvas = document.getElementById('canvas');
const exportBtn = document.getElementById('exportBtn');
const ctx = canvas.getContext('2d');

// Размеры листа (рабочей области)
const sheetWidth = 1000;
const sheetHeight = 1000;
canvas.width = sheetWidth;
canvas.height = sheetHeight;

let processedDXF = null; // Здесь будет сохранён итоговый DXF после упаковки

// --- Обработка drag-and-drop ---
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('hover');
});
dropZone.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dropZone.classList.remove('hover');
});
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('hover');
  const file = e.dataTransfer.files[0];
  if (file) readFile(file);
});
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) readFile(file);
});
exportBtn.addEventListener('click', () => {
  if (processedDXF) {
    const dxfContent = exportDXF(processedDXF);
    downloadDXF(dxfContent, 'processed.dxf');
  }
});

// --- Чтение и парсинг DXF ---
function readFile(file) {
  const reader = new FileReader();
  reader.onload = () => parseDXF(reader.result);
  reader.readAsText(file);
}

function parseDXF(dxfText) {
  const parser = new window.DxfParser();
  try {
    const dxf = parser.parseSync(dxfText);
    // Преобразуем сущности в единый формат (линии и полилинии)
    const parts = prepareEntities(dxf.entities);
    // Запускаем алгоритм упаковки для нескольких деталей
    nestParts(parts, sheetWidth, sheetHeight).then(nestedParts => {
      // Обновляем исходный DXF, заменяя координаты сущностей
      nestedParts.forEach((part, idx) => {
        dxf.entities[idx].vertices = part.vertices;
      });
      processedDXF = dxf;
      drawAllParts(nestedParts);
      exportBtn.style.display = "inline-block";
    });
  } catch (err) {
    console.error("Ошибка парсинга DXF:", err);
    alert("Не удалось разобрать DXF-файл. Проверьте его корректность.");
  }
}

// Преобразование сущностей в единый формат с массивом вершин
function prepareEntities(entities) {
  const parts = [];
  entities.forEach(entity => {
    if (entity.type === "LINE") {
      parts.push({
        type: entity.type,
        vertices: [
          { x: entity.vertices[0].x, y: entity.vertices[0].y },
          { x: entity.vertices[1].x, y: entity.vertices[1].y }
        ]
      });
    } else if (entity.type === "LWPOLYLINE") {
      parts.push({
        type: entity.type,
        vertices: entity.vertices.map(v => ({ x: v.x, y: v.y }))
      });
    }
  });
  return parts;
}

// --- Алгоритм упаковки нескольких деталей (Multi-Part Nesting) ---
// Сортируем детали по площади bounding box (от большего к меньшему)
// и для каждой перебираем повороты и смещения, чтобы найти позицию, где деталь
// не пересекается с уже размещёнными и полностью укладывается на листе.
async function nestParts(parts, sheetW, sheetH) {
  parts.sort((a, b) => computeArea(b) - computeArea(a));
  const placedParts = [];
  
  for (let part of parts) {
    const placed = await placePart(part, placedParts, sheetW, sheetH);
    if (placed) {
      placedParts.push(placed);
    } else {
      console.warn("Не удалось разместить деталь:", part);
    }
  }
  return placedParts;
}

// Вычисление площади bounding box детали
function computeArea(part) {
  const bbox = computeBoundingBox(part);
  return (bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY);
}

// Перебор поворотов (с шагом 1° для ускорения; можно повысить до 0.1°)
// и вариантов позиционирования (с шагом 10 пикселей) для поиска размещения
async function placePart(part, placedParts, sheetW, sheetH) {
  for (let angle = 0; angle < 360; angle += 1) {
    const rotated = rotateEntity(part, angle);
    const bbox = computeBoundingBox(rotated);
    const partW = bbox.maxX - bbox.minX;
    const partH = bbox.maxY - bbox.minY;
    
    for (let x = 0; x <= sheetW - partW; x += 10) {
      for (let y = 0; y <= sheetH - partH; y += 10) {
        const shifted = shiftEntity(rotated, x - bbox.minX, y - bbox.minY);
        if (!fitsOnSheet(shifted, sheetW, sheetH)) continue;
        if (collidesWith(shifted, placedParts)) continue;
        return shifted;
      }
    }
  }
  return null;
}

// Проверка на коллизии (через bounding box)
function collidesWith(entity, placedParts) {
  const bbox1 = computeBoundingBox(entity);
  for (let other of placedParts) {
    const bbox2 = computeBoundingBox(other);
    if (bboxOverlap(bbox1, bbox2)) return true;
  }
  return false;
}

function bboxOverlap(b1, b2) {
  return !(b1.maxX < b2.minX || b1.minX > b2.maxX ||
           b1.maxY < b2.minY || b1.minY > b2.maxY);
}

function shiftEntity(entity, dx, dy) {
  const shiftedVertices = entity.vertices.map(v => ({ x: v.x + dx, y: v.y + dy }));
  return Object.assign({}, entity, { vertices: shiftedVertices });
}

// --- Функции поворота, вычисления bounding box и проверки размещения ---
function rotatePoint(x, y, angle, cx = 0, cy = 0) {
  const rad = angle * Math.PI / 180;
  return {
    x: Math.cos(rad) * (x - cx) - Math.sin(rad) * (y - cy) + cx,
    y: Math.sin(rad) * (x - cx) + Math.cos(rad) * (y - cy) + cy
  };
}

function computeBoundingBox(entity) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  entity.vertices.forEach(v => {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  });
  return { minX, minY, maxX, maxY };
}

function rotateEntity(entity, angle) {
  const bbox = computeBoundingBox(entity);
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cy = (bbox.minY + bbox.maxY) / 2;
  const rotatedVertices = entity.vertices.map(v => rotatePoint(v.x, v.y, angle, cx, cy));
  return Object.assign({}, entity, { vertices: rotatedVertices });
}

function fitsOnSheet(entity, sheetW, sheetH) {
  const bbox = computeBoundingBox(entity);
  return (bbox.minX >= 0 && bbox.minY >= 0 && bbox.maxX <= sheetW && bbox.maxY <= sheetH);
}

// --- Отрисовка и экспорт ---
function drawAllParts(parts) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  parts.forEach(part => drawEntity(part));
}

function drawEntity(entity) {
  if (!entity.vertices || entity.vertices.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(entity.vertices[0].x, entity.vertices[0].y);
  for (let i = 1; i < entity.vertices.length; i++) {
    ctx.lineTo(entity.vertices[i].x, entity.vertices[i].y);
  }
  if (entity.type === "LWPOLYLINE") ctx.closePath();
  ctx.stroke();
}

// Экспорт итогового DXF (минимальная реализация)
function exportDXF(dxf) {
  let dxfText = "0\nSECTION\n2\nENTITIES\n";
  dxf.entities.forEach(entity => {
    if (entity.type === "LINE") {
      dxfText += "0\nLINE\n8\n0\n";
      dxfText += `10\n${entity.vertices[0].x}\n20\n${entity.vertices[0].y}\n`;
      dxfText += `11\n${entity.vertices[1].x}\n21\n${entity.vertices[1].y}\n`;
    } else if (entity.type === "LWPOLYLINE") {
      dxfText += "0\nLWPOLYLINE\n8\n0\n";
      dxfText += "90\n" + entity.vertices.length + "\n";
      entity.vertices.forEach(v => {
        dxfText += `10\n${v.x}\n20\n${v.y}\n`;
      });
    }
  });
  dxfText += "0\nENDSEC\n0\nEOF\n";
  return dxfText;
}

function downloadDXF(content, filename) {
  const blob = new Blob([content], { type: "application/dxf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}