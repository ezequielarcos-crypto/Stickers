# StickerLab · Creador de stickers para WhatsApp

App web para crear stickers de WhatsApp desde el celular o la compu. Corre 100 % en el navegador:
las fotos no se suben a ningún servidor. Es una PWA, así que se puede instalar como app.

## Funciones

**Recorte**
- **Quitar fondo (IA):** detecta el sujeto principal y borra el fondo automáticamente.
- **Lazo auto (IA):** tocás un objeto o persona y la IA lo recorta sola.
- **Lazo libre:** dibujás con el dedo alrededor de lo que querés conservar.
- **Lazo lineal (poligonal):** recorte con puntos y líneas rectas.
- **Varita mágica:** borra zonas de color parecido (tolerancia ajustable, zona conectada o global).
- **Rectángulo y círculo.**
- **Borrador y Restaurar** con tamaño de pincel y modo "pincel desplazado" para ver bajo el dedo.
- Cada herramienta puede **conservar**, **borrar** o **agregar** la zona marcada.
- **Refinar:** suavizar bordes, contraer o expandir el borde (quita halos), invertir y restablecer.
- Zoom con pellizco o rueda, deshacer/rehacer y vista "ver quitado".

**Decoración** (lienzo de 512×512, el tamaño que pide WhatsApp)
- **Borde** blanco o de color alrededor de todo el sticker, con grosor ajustable.
- **Texto** con 8 fuentes, relleno, contorno y varias líneas.
- **Emojis** como capas.
- Mover, escalar, rotar (con dos dedos o el tirador), espejar, duplicar, ordenar capas.
- **Filtros** (brillo, contraste, saturación, calidez y presets), **sombra** y **fondo**.
- Stickers de **solo texto**.

**Paquetes y exportación**
- Paquetes guardados en el dispositivo (IndexedDB) con nombre, autor e ícono (bandeja 96×96).
- Exporta WebP de 512×512 ajustando la calidad para quedar **por debajo de 100 KB**.
- Valida las reglas de WhatsApp (3 a 30 stickers, tamaños, nombres).

## Cómo llegan los stickers a WhatsApp

Un sitio web no puede instalar un paquete en WhatsApp por sí solo (eso requiere una app nativa con el SDK
de WhatsApp). StickerLab ofrece las vías que sí funcionan desde el navegador:

1. **Compartir (Android/iPhone):** en el paquete tocá un sticker → *Compartir a WhatsApp*. Llega como sticker;
   mantenelo presionado en el chat y elegí *Añadir a Favoritos*. También podés compartir todos juntos.
2. **Archivo `.wastickers`:** paquete completo (`title.txt`, `author.txt`, `tray.png` y los `.webp`)
   para abrir con una app importadora de paquetes de WhatsApp.
3. **WhatsApp Web / Escritorio:** descargá el ZIP de `.webp` y arrastrá los archivos a un chat.
4. **ZIP para desarrolladores:** `contents.json` + carpeta en el formato del proyecto oficial
   [WhatsApp/stickers](https://github.com/WhatsApp/stickers), para compilar tu propia app de stickers.

En Android, instalada como PWA, la app también aparece en el menú *Compartir* de la galería para abrir
una foto directamente.

## Ejecutar

No necesita compilación. Cualquier servidor estático sirve:

```bash
python3 -m http.server 8080
# abrir http://localhost:8080
```

Para usarla desde el celular conviene publicarla con HTTPS (la cámara, compartir archivos y la instalación
como app lo requieren). Con GitHub Pages: *Settings → Pages → Deploy from a branch* → rama principal, carpeta `/`.

## Estructura

| Archivo | Qué hace |
| --- | --- |
| `index.html`, `css/app.css` | Interfaz (pensada primero para celular, con modo oscuro) |
| `js/main.js` | Navegación, paneles, guardado y exportación |
| `js/cutter.js` | Editor de recorte: máscara, herramientas, zoom, historial |
| `js/composer.js` | Editor de decoración: capas, borde, sombra, texto |
| `js/imageops.js` | Varita mágica, transformada de distancia (bordes), desenfoque, filtros |
| `js/ai.js` | IA cargada bajo demanda desde CDN |
| `js/encoder.js` | WebP ≤ 100 KB (nativo o libwebp en WASM para Safari) e ícono de bandeja |
| `js/whatsapp.js`, `js/zip.js` | `.wastickers`, ZIPs y compartir |
| `js/store.js` | Paquetes en IndexedDB |
| `sw.js`, `manifest.webmanifest` | PWA: uso sin conexión y recibir imágenes compartidas |

## Bibliotecas externas (se descargan solo al usarlas)

- [`@imgly/background-removal`](https://github.com/imgly/background-removal-js) 1.7.0 — quitar fondo.
  **Licencia AGPL-3.0**: si publicás la app, tené en cuenta sus condiciones (o reemplazala por otro modelo).
- [`@mediapipe/tasks-vision`](https://github.com/google-ai-edge/mediapipe) 0.10.21 con el modelo
  *Magic Touch* — lazo automático (Apache-2.0).
- [`@jsquash/webp`](https://github.com/jamsinclair/jSquash) 1.5.0 — codificador WebP para Safari (Apache-2.0).

La primera vez que se usa cada función de IA se descarga su modelo (unos MB); después queda en la caché
del navegador.
