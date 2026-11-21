# Minato Hub

Panel y gestor de hosting ligero, multi-instancia y de costo $0 para bots y servicios Node.js.
Solo depende de `pg` (PostgreSQL en Neon); la configuración de las instancias vive en la base de datos.

## Ejecutar en local

```bash
npm install
cp .env.example .env     # completa DATABASE_URL y MINATO_SECRET
npm start                # http://localhost:3000
```

## Desplegar gratis en Render

1. Crea una base de datos gratuita en [Neon](https://neon.tech) y copia su `DATABASE_URL`.
2. En Render: **New → Blueprint** y selecciona este repositorio (usa `render.yaml` y el `Dockerfile`).
3. Pega `DATABASE_URL` cuando lo pida. `MINATO_SECRET` se genera solo (míralo en *Environment*).
4. Mantenlo despierto: el plan gratis duerme tras 15 min sin tráfico. Crea un monitor HTTP cada 5 min a
   `https://TU-SERVICIO.onrender.com/health` (UptimeRobot o cron-job.org, ambos gratuitos).

El disco de Render es efímero: en cada reinicio Minato vuelve a clonar e instalar las instancias habilitadas.

## Desplegar en una VM (Oracle Cloud Always Free u otra)

```bash
docker build -t minato-hub .
docker run -d --name minato --restart unless-stopped -p 3000:3000 \
  -e DATABASE_URL='...' -e MINATO_SECRET='...' -v minato-data:/data minato-hub
```

## API

Todas las rutas `/api/*` requieren `x-minato-token: <MINATO_SECRET>` o `Authorization: Bearer <MINATO_SECRET>`.
`GET /health` es público.

| Método y ruta | Acción |
|---|---|
| `GET /api/metrics` | RAM, uptime y número de instancias |
| `GET/POST /api/instances` | Listar / crear |
| `GET/PUT/DELETE /api/instances/:id` | Ver / editar / eliminar |
| `POST /api/instances/:id/{start,stop,restart,deploy}` | Control del proceso |
| `GET /api/instances/:id/logs?since=N` | Últimas ~200 líneas |

Nodos remotos: define `MINATO_NODES` (ver `.env.example`) y usa `target_node=<nombre>`.
