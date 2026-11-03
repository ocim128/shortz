import os
import re
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# Directories & Fonts
input_dir = r'C:\Users\user\Videos\ShortZ\Downloads\instagram\valorgi\Ddw6SBhiMZo'
output_dir = r'C:\Users\user\Videos\ShortZ\Downloads\instagram\valorgi\Ddw6SBhiMZo\versi_indonesia'
os.makedirs(output_dir, exist_ok=True)

font_anton = r'fonts\Anton-Regular.ttf'
font_montserrat = r'fonts\Montserrat-Variable.ttf'

# 1. Precompute watermark mask using morphological tophat across multiple slides
def get_clean_watermark_mask():
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))
    tophats = []
    for i in [3, 4, 7, 8]:
        f = f'ig_Ddw6SBhiMZo_v{i}.jpg'
        img = cv2.imread(os.path.join(input_dir, f))
        crop = img[12:92, 920:1060]
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        th = cv2.morphologyEx(gray, cv2.MORPH_TOPHAT, kernel)
        tophats.append(th)
    min_th = np.minimum.reduce(tophats)
    wm_crop_mask = (min_th > 8).astype(np.uint8) * 255
    k_dil = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    return cv2.dilate(wm_crop_mask, k_dil, iterations=1)

wm_mask_crop = get_clean_watermark_mask()
h_wm, w_wm = wm_mask_crop.shape

# Helper for rich typography rendering (bold & regular mixed)
def render_rich_paragraphs(draw, paragraphs, start_x, start_y, max_w=820, font_size=31, line_spacing=1.45, para_gap=32):
    f_reg = ImageFont.truetype(font_montserrat, font_size)
    f_reg.set_variation_by_name('Regular')
    f_bold = ImageFont.truetype(font_montserrat, font_size)
    f_bold.set_variation_by_name('Bold')
    
    line_h = int(font_size * line_spacing)
    cur_y = start_y
    space_w = f_reg.getlength(' ')
    
    for p in paragraphs:
        tokens = re.split(r'(\*\*.*?\*\*)', p)
        chunks = []
        for token in tokens:
            if not token:
                continue
            if token.startswith('**') and token.endswith('**'):
                chunks.append((token[2:-2], True))
            else:
                chunks.append((token, False))
        
        words_raw = []
        for text, is_b in chunks:
            parts = re.split(r'(\s+)', text)
            for part in parts:
                if not part:
                    continue
                if part.isspace():
                    words_raw.append((' ', False, True))
                else:
                    words_raw.append((part, is_b, False))
        
        compact_words = []
        for w, is_b, is_sp in words_raw:
            if is_sp:
                compact_words.append((' ', False, True))
            else:
                if compact_words and not compact_words[-1][2]:
                    prev_w, prev_b, _ = compact_words[-1]
                    compact_words[-1] = (prev_w + w, prev_b, False)
                else:
                    compact_words.append((w, is_b, False))
                    
        clean_words = []
        for w, is_b, is_sp in compact_words:
            if not is_sp:
                f = f_bold if is_b else f_reg
                w_len = f.getlength(w)
                clean_words.append((w, is_b, w_len))
        
        # Word wrap into lines
        lines = []
        current_line = []
        current_line_w = 0
        for word, is_b, w_len in clean_words:
            needed_w = (space_w if current_line else 0) + w_len
            if current_line_w + needed_w <= max_w:
                current_line.append((word, is_b, w_len))
                current_line_w += needed_w
            else:
                if current_line:
                    lines.append(current_line)
                current_line = [(word, is_b, w_len)]
                current_line_w = w_len
        if current_line:
            lines.append(current_line)
            
        for line in lines:
            cur_x = start_x
            for i, (word, is_b, w_len) in enumerate(line):
                f = f_bold if is_b else f_reg
                col = (255, 255, 255) if is_b else (235, 235, 235)
                # Subtle drop shadow
                draw.text((cur_x, cur_y + 2), word, font=f, fill=(0, 0, 0, 160))
                draw.text((cur_x, cur_y), word, font=f, fill=col)
                cur_x += w_len
                if i < len(line) - 1:
                    cur_x += space_w
            cur_y += line_h
            
        cur_y += para_gap

# Slide 1: Intro
def process_slide_1(in_path, out_path):
    img = cv2.imread(in_path)
    h, w, _ = img.shape
    
    # Bottom half from y=650 to 1440 is black background for text
    for y in range(650, 1440):
        if y >= 730:
            alpha = 1.0
        else:
            t = (y - 650) / (730 - 650)
            alpha = 0.5 * (1.0 - np.cos(np.pi * t))
        img[y, :] = (img[y, :].astype(np.float32) * (1.0 - alpha)).astype(np.uint8)
        
    img_pil = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(img_pil)
    
    lines = [
        'MEREKA BIKIN KAMU PERCAYA',
        'MATAHARI, GARAM, DAN LEMAK',
        'BISA MEMBUNUHMU.',
        'LALU MEREKA MERAUP CUAN BESAR',
        'DENGAN JUALAN \'SOLUSINYA\'.',
        'INI 8 KEBOHONGAN YANG',
        'MEMICU EPIDEMI KESEHATAN.'
    ]
    
    f = ImageFont.truetype(font_anton, 64)
    line_h = 76
    total_h = len(lines) * line_h
    start_y = 780 + (1440 - 780 - total_h) // 2
    
    for i, line in enumerate(lines):
        bbox = f.getbbox(line)
        lw = bbox[2] - bbox[0]
        lx = (w - lw) // 2 - bbox[0]
        ly = start_y + i * line_h - bbox[1]
        # Shadow
        draw.text((lx, ly + 3), line, font=f, fill=(0, 0, 0, 220))
        # Text
        draw.text((lx, ly), line, font=f, fill=(251, 191, 72))
        
    img_pil.save(out_path, quality=95)
    print('Generated slide_1.jpg')

# Content Slides: Slides 2 to 9
def process_content_slide(in_path, out_path, lie_num, lie_title, paras):
    img = cv2.imread(in_path)
    h, w, _ = img.shape
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    
    # 1. Tiered text mask tailored to text boundaries across slides
    text_mask = np.zeros_like(gray)
    text_mask[80:750, 40:880] = (gray[80:750, 40:880] > 65).astype(np.uint8) * 255
    text_mask[750:1050, 40:925] = (gray[750:1050, 40:925] > 65).astype(np.uint8) * 255
    text_mask[1050:1280, 40:975] = (gray[1050:1280, 40:975] > 65).astype(np.uint8) * 255
    
    # 2. Watermark mask
    wm_mask = np.zeros_like(gray)
    wm_mask[12:12+h_wm, 920:920+w_wm] = wm_mask_crop
    
    combined_mask = cv2.bitwise_or(text_mask, wm_mask)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    dilated = cv2.dilate(combined_mask, kernel, iterations=1)
    inpainted = cv2.inpaint(img, dilated, 2, cv2.INPAINT_TELEA)
    
    # 3. Smooth cosine black gradient on the left side
    gradient = np.zeros((h, w), dtype=np.float32)
    grad_solid = 480
    for y in range(h):
        if y < 750:
            cur_end = 880
        elif y > 1050:
            cur_end = 970
        else:
            ty = (y - 750) / 300.0
            cur_end = 880 + ty * 90.0
        for x in range(w):
            if x <= grad_solid:
                gradient[y, x] = 1.0
            elif x <= cur_end:
                t = (x - grad_solid) / (cur_end - grad_solid)
                gradient[y, x] = 0.5 * (1.0 + np.cos(np.pi * t))
            else:
                gradient[y, x] = 0.0

    result = inpainted.astype(np.float32) * (1.0 - gradient[:, :, np.newaxis])
    result = np.clip(result, 0, 255).astype(np.uint8)
    
    img_pil = Image.fromarray(cv2.cvtColor(result, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(img_pil)
    
    # Render Headline
    f_h1 = ImageFont.truetype(font_anton, 75)
    f_h2 = ImageFont.truetype(font_anton, 58)
    
    # Headline drop shadows
    draw.text((65, 113), f'KEBOHONGAN #{lie_num}:', font=f_h1, fill=(0, 0, 0, 220))
    draw.text((65, 110), f'KEBOHONGAN #{lie_num}:', font=f_h1, fill=(251, 191, 72))
    
    draw.text((65, 208), f'‘{lie_title}’', font=f_h2, fill=(0, 0, 0, 220))
    draw.text((65, 205), f'‘{lie_title}’', font=f_h2, fill=(251, 191, 72))
    
    render_rich_paragraphs(draw, paras, 65, 325, max_w=820, font_size=31, line_spacing=1.45, para_gap=32)
    
    img_pil.save(out_path, quality=95)
    print(f'Generated slide for Lie #{lie_num}')

# Slide 10: Outro CTA
def process_slide_10(in_path, out_path):
    img = cv2.imread(in_path)
    h, w, _ = img.shape
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    
    # Inpaint text & watermark
    text_mask = np.zeros_like(gray)
    text_mask[120:1250, 40:660] = (gray[120:1250, 40:660] > 60).astype(np.uint8) * 255
    
    wm_mask = np.zeros_like(gray)
    wm_mask[12:12+h_wm, 920:920+w_wm] = wm_mask_crop
    
    combined_mask = cv2.bitwise_or(text_mask, wm_mask)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    dilated = cv2.dilate(combined_mask, kernel, iterations=1)
    inpainted = cv2.inpaint(img, dilated, 2, cv2.INPAINT_TELEA)
    
    # Smooth gradient on left (solid black x: 0..460, fade to transparent at x: 720)
    gradient = np.zeros((h, w), dtype=np.float32)
    for x in range(w):
        if x <= 460:
            gradient[:, x] = 1.0
        elif x <= 720:
            t = (x - 460) / (720 - 460)
            gradient[:, x] = 0.5 * (1.0 + np.cos(np.pi * t))
        else:
            gradient[:, x] = 0.0

    result = inpainted.astype(np.float32) * (1.0 - gradient[:, :, np.newaxis])
    result = np.clip(result, 0, 255).astype(np.uint8)
    
    img_pil = Image.fromarray(cv2.cvtColor(result, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(img_pil)
    
    lines = [
        'KAMU MUNGKIN',
        'GAK AKAN PERNAH',
        'LIHAT AKUN INI',
        'LAGI KALAU GAK',
        'FOLLOW SEKARANG.'
    ]
    
    f = ImageFont.truetype(font_anton, 85)
    cur_y = 310
    line_h = 105
    for line in lines:
        draw.text((65, cur_y + 4), line, font=f, fill=(0, 0, 0, 220))
        draw.text((65, cur_y), line, font=f, fill=(251, 191, 72))
        cur_y += line_h
        
    img_pil.save(out_path, quality=95)
    print('Generated slide_10.jpg')

# --- EXECUTE ALL SLIDES ---

# 1. Slide 1 (Intro)
process_slide_1(
    os.path.join(input_dir, 'ig_Ddw6SBhiMZo.jpg'),
    os.path.join(output_dir, 'slide_1.jpg')
)

# 2. Slide 2 (Lie #1)
process_content_slide(
    os.path.join(input_dir, 'ig_Ddw6SBhiMZo_v2.jpg'),
    os.path.join(output_dir, 'slide_2.jpg'),
    1,
    'MAKAN LEMAK BIKIN KAMU GEMUK',
    [
        'Setiap sel di tubuhmu itu **dikelilingi lemak**. **Otakmu** sebagian besar tersusun dari lemak. **Hormonmu** dibentuk dari lemak. Tapi mereka ngeyakinin kamu kalau lemak itu sumber penyakit, lalu nyuruh kamu beralih ke makanan **"low-fat"** yang isinya malah dibanjiri gula.',
        'Waktu konsumsi lemak turun drastis, angka obesitas dan diabetes justru meledak. Musuh aslinya bukan lemak, **tapi gula**. Tren "low-fat" dulu bukan panduan kesehatan, tapi ladang bisnis raksasa.',
        'Mereka mencabut sumber energi alami tubuh dan menggantinya dengan karbohidrat murah dari jagung, kedelai, dan gandum. Ini bukan cuma ngerusak pola makanmu, **tapi bikin kecanduan**.'
    ]
)

# 3. Slide 3 (Lie #2)
process_content_slide(
    os.path.join(input_dir, 'ig_Ddw6SBhiMZo_v3.jpg'),
    os.path.join(output_dir, 'slide_3.jpg'),
    2,
    'DAGING MERAH BIKIN KANKER',
    [
        'Manusia sudah berburu dan makan **daging merah selama jutaan tahun**. Tapi sekarang, kamu ditakut-takuti kalau sepotong steak bakal jadi penyebab utama kanker.',
        'Padahal yang sering dijadikan kambing hitam adalah studi observasional yang **gak membedakan antara daging asli tanpa olahan dengan burger cepat saji**, sosis pabrikan, dan gaya hidup minim gerak.',
        'Daging merah berkualitas tinggi adalah salah satu makanan paling padat nutrisi di bumi—kaya akan **zat besi heme, vitamin B12, karnosin, dan kreatin** yang sulit didapat secara optimal dari tumbuhan.',
        'Bukan dagingnya yang jadi racun, **tapi makanan ultra-proses pendampingnya**.'
    ]
)

# 4. Slide 4 (Lie #3)
process_content_slide(
    os.path.join(input_dir, 'ig_Ddw6SBhiMZo_v4.jpg'),
    os.path.join(output_dir, 'slide_4.jpg'),
    3,
    'SINAR MATAHARI ITU BERBAHAYA',
    [
        'Kamu diajarin buat takut sama sumber kehidupan paling mendasar di bumi: **matahari**.',
        'Disuruh ngurung diri di dalam ruangan ber-AC, dan kalaupun keluar harus dibaluri sunscreen berbahan kimia beracun dari ujung kepala sampai kaki.',
        'Padahal, paparan sinar matahari langsung memicu produksi **vitamin D, oksida nitrat, dan melatonin**. Ketiganya adalah pilar penting daya tahan tubuh, kesehatan pembuluh darah, dan kualitas tidur.',
        'Defisiensi vitamin D kronis berkaitan langsung dengan risiko kanker, depresi, dan penyakit autoimun. **Matahari gak berbahaya kalau dinikmati bijak. Yang bahaya adalah ketakutan berlebihan yang dijual demi industri lotion & skincare**.'
    ]
)

# 5. Slide 5 (Lie #4)
process_content_slide(
    os.path.join(input_dir, 'ig_Ddw6SBhiMZo_v5.jpg'),
    os.path.join(output_dir, 'slide_5.jpg'),
    4,
    'SARAPAN ADALAH POLA MAKAN TERPENTING',
    [
        'Slogan ini bukan lahir dari riset sains medis, **tapi dari kampanye pemasaran perusahaan sereal di abad ke-20**.',
        'Secara biologis, saat bangun tidur tubuh kita punya kadar kortisol alami yang tinggi—tubuh sudah siap memakai cadangan energi tanpa harus langsung dijejali kalori.',
        'Tapi kamu dibiasakan sarapan tinggi karbohidrat olahan: roti manis, sereal kotak, atau jus kemasan. Akibatnya? **Gula darah melonjak drastis lalu anjlok seketika (sugar crash)**, bikin kamu gampang lemas dan lapar lagi dalam 2 jam.',
        'Puasa intermiten (intermittent fasting) justru terbukti membantu autofagi, sensitivitas insulin, dan fokus mental.'
    ]
)

# 6. Slide 6 (Lie #5)
process_content_slide(
    os.path.join(input_dir, 'ig_Ddw6SBhiMZo_v6.jpg'),
    os.path.join(output_dir, 'slide_6.jpg'),
    5,
    'PERANG MELAWAN KOLESTEROL',
    [
        'Faktanya, separuh orang yang meninggal karena serangan jantung punya **kadar kolesterol normal**. Bahkan orang dengan kolesterol yang agak tinggi sering kali berumur lebih panjang, terutama saat memasuki usia lanjut.',
        'Tapi kamu ditakut-takuti kalau molekul penting ini adalah **bom waktu**. Padahal musuh sesungguhnya bukan kolesterol, **tapi inflamasi (peradangan kronis)**.',
        'Kolesterol adalah bahan baku utama pembentuk **hormon, fungsi otak, dan perbaikan sel**. Bukannya memperbaiki pola makan dan gaya hidup, jutaan orang langsung diresepkan obat penurun kolesterol.',
        'Melahirkan **industri bernilai miliaran dolar** dengan pelanggan seumur hidup.'
    ]
)

# 7. Slide 7 (Lie #6)
process_content_slide(
    os.path.join(input_dir, 'ig_Ddw6SBhiMZo_v7.jpg'),
    os.path.join(output_dir, 'slide_7.jpg'),
    6,
    'FLUORIDE BIKIN GIGI AMAN',
    [
        'Mereka bilang ini demi kesehatanmu. Rasanya aneh kan kalau ada zat yang begitu \'bermanfaat\' tapi sengaja dicampur ke air keran umum secara gratis? Faktanya, sebagian besar negara maju di Eropa sudah **melarang fluoride** di air minum mereka. Apa yang mereka sadari tapi diabaikan oleh banyak pihak?',
        'Alasan **"perlindungan gigi"** awalnya hanyalah trik marketing. Cara cerdas membuang limbah sampingan industri tanpa perlu bayar biaya filter pengolahan yang mahal.',
        'Dosis berlebih berkaitan dengan gangguan tiroid, penurunan fungsi kognitif, dan kerapuhan tulang. Bahaya terbesarnya bukan gigi berlubang, **tapi paparan kimiawi terus-menerus tanpa kita punya pilihan**.'
    ]
)

# 8. Slide 8 (Lie #7)
process_content_slide(
    os.path.join(input_dir, 'ig_Ddw6SBhiMZo_v8.jpg'),
    os.path.join(output_dir, 'slide_8.jpg'),
    7,
    'GARAM MENINGKATKAN TEKANAN DARAH',
    [
        'Kamu diperingatkan kalau **garam bakal ngerusak jantungmu**, dan disuruh memangkas garam habis-habisan. Padahal, banyak populasi tradisional yang mengonsumsi tinggi garam selama berabad-abad punya riwayat hipertensi yang sangat rendah. Masalah baru muncul waktu makanan olahan pabrik dan gula mulai masuk. **Di situlah semuanya rusak**.',
        'Bahaya sesungguhnya bukan garam alami, melainkan **defisiensi mineral seimbang** (seperti kalium & magnesium).',
        'Saat kamu sibuk takut sama garam, mereka mempromosikan **gula, minyak nabati rafinasi (seed oils), dan junk food**—pemicu asli kerusakan pembuluh darah.',
        'Ketakutan pada garam bukan bentuk proteksi, **tapi pengalihan isu**.'
    ]
)

# 9. Slide 9 (Lie #8)
process_content_slide(
    os.path.join(input_dir, 'ig_Ddw6SBhiMZo_v9.jpg'),
    os.path.join(output_dir, 'slide_9.jpg'),
    8,
    'KAMU CUMA KURANG NUTRISI',
    [
        'Coba tanya dokter forensik apa yang paling sering ditemukan di tubuh orang yang meninggal. Sering kali bukan penyakit misterius, **tapi defisiensi nutrisi kronis**.',
        'Tapi keluhan seperti **lemas berkepanjangan (chronic fatigue), brain fog, dan kecemasan** jarang banget dicari akar masalahnya dari kekurangan nutrisi.',
        '**Kekurangan nutrisi** langsung divonis sebagai penyakit baru, lalu gejalanya dijadikan hukuman obat seumur hidup. Industri farmasi **gak dapat untung dari magnesium, sinar matahari, atau real food**. Akhirnya sinyal minta tolong dari tubuhmu malah disumbat obat-obatan.',
        '**Tubuhmu gak rusak. Tubuhmu cuma kelaparan nutrisi**.'
    ]
)

# 10. Slide 10 (Outro)
process_slide_10(
    os.path.join(input_dir, 'ig_Ddw6SBhiMZo_v10.jpg'),
    os.path.join(output_dir, 'slide_10.jpg')
)

# Write Caption file
caption_text = """Berapa banyak dari mitos ini yang sampai sekarang masih kamu percaya? 👀

Selama puluhan tahun, kita dicekoki narasi kalau tubuh kita ini lemah dan gampang rusak kalau gak ditopang sama "solusi" buatan industri. Lemak alami dijauhi, matahari ditakuti, garam dimusuhi—ujung-ujungnya diganti sama produk olahan pabrik dan obat penurun gejala seumur hidup.

Saatnya balik ke akal sehat dan pola hidup alami:
🥩 Makan real food padat nutrisi
☀️ Rutin berjemur dan kenal matahari
🧈 Jangan fobia sama lemak baik alami
💧 Minum air bersih bebas racun tambahan

Dari 8 poin di atas, mana kebohongan yang paling bikin kamu kaget pas pertama kali tahu faktanya? Diskusi di kolom komentar yuk! 👇

#kesehatanalami #mitoskesehatan #hidupsehat #realfood #nutrisialami #biohackingindonesia #edukasikesehatan #polahidupsehat"""

with open(os.path.join(output_dir, 'caption.txt'), 'w', encoding='utf-8') as f_cap:
    f_cap.write(caption_text.strip())

print('Caption saved successfully!')
print('All 10 slides successfully processed and generated!')
