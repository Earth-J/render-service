# Render Service (Microservice)

บริการเรนเดอร์ GIF/MP4 ภายนอกสำหรับบอท Discord เพื่อลดภาระ CPU ของตัวบอท

## ติดตั้งและรัน

```bash
cd render-service
npm install
ASSET_BASE_URL=https://pub-10fb2b4fd6a44827a05411c2effacaa9.r2.dev npm start
```

ค่าปริยายจะรันที่ `http://localhost:8081`

## Environment Variables

- `PORT` (optional): พอร์ตที่ service จะฟัง (default: 8081)
- `PUBLIC_BASE_URL` (optional): Base URL ภายในที่ใช้ log เท่านั้น
- `API_KEY` (optional): โทเคนสำหรับป้องกันการเข้าถึง API; ถ้าตั้งค่า บอทต้องส่ง `Authorization: Bearer <API_KEY>`
- `ASSET_BASE_URL` (สำคัญ): โดเมน/ฐานพาธ CDN ของไฟล์ asset เช่น `https://pub-...r2.dev`

## รูปแบบไฟล์บน CDN (แนะนำ)

- floor: `<ASSET_BASE_URL>/floor/<key>.gif`
- furniture: `<ASSET_BASE_URL>/furniture/<key>.gif`
- wallpaper-left: `<ASSET_BASE_URL>/wallpaper/left/<key>.gif`
- wallpaper-right: `<ASSET_BASE_URL>/wallpaper/right/<key>.gif`
- background: `<ASSET_BASE_URL>/backgrounds/default.png`

`<key>` คือคีย์จากโมเดลบ้าน (แปลงเป็น slug ตัวพิมพ์เล็กอัตโนมัติ): ช่องว่าง/สัญลักษณ์จะถูกแทนด้วย `-`

## Endpoints

- `POST /jobs`
  - Body JSON ตัวอย่าง:
  ```json
  {
    "guild": "<guildId>",
    "user": "<userId>",
    "size": { "width": 300, "height": 300 },
    "fps": 12,
    "durationMs": 2000,
    "format": "gif",
    "layers": [
      { "type": "background", "key": "default" },
      { "type": "floor", "key": "wood-01" },
      { "type": "furniture", "key": "sofa-01" }
    ]
  }
  ```
  - Response: `{ "jobId": "..." }`

- `GET /jobs/:id`
  - Response (mock ปัจจุบันจะเลือก URL จาก CDN ตามลำดับความสำคัญของเลเยอร์):
  ```json
  { "status": "done", "url": "https://<ASSET_BASE_URL>/floor/wood-01.gif" }
  ```

## หมายเหตุ

- เวอร์ชันปัจจุบันยัง mock (คืน URL ของเลเยอร์บน CDN เพื่อ Preview เร็ว) เพื่อให้เชื่อมกับบอทได้ก่อน
- หากต้องการเรนเดอร์ซ้อนเลเยอร์จริง (compose หลาย GIF/PNG เป็นภาพเคลื่อนไหว) จะเพิ่มตัวเข้ารหัสภายหลัง แล้วอัปเดตผลลัพธ์เป็นไฟล์ที่สร้างใหม่ 