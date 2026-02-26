# trazea-auth

Página de activación de cuenta para la app Trazea. Gestiona el flujo de invitación de Supabase: el usuario hace clic en el enlace del email, establece su contraseña y abre la app.

**URL de producción:** `https://auth.trazea.es`

---

## Configuración

Copia `.env.example` a `.env.local` y rellena las variables:

```
NEXT_PUBLIC_SUPABASE_URL=https://XXXXXX.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_xxx
NEXT_PUBLIC_APP_SCHEME=trazea
```

> `NEXT_PUBLIC_SUPABASE_ANON_KEY` es la clave **pública** (anon/publishable). Es seguro incluirla en el frontend.  
> **Nunca** uses `SUPABASE_SERVICE_KEY` aquí.

---

## Desarrollo local

```bash
npm install
npm run dev
```

---

## Despliegue en Vercel

### 1. Subir a GitHub

```bash
git add .
git commit -m "Convert to Next.js"
git push
```

### 2. Crear/actualizar proyecto en Vercel

1. Ve a [vercel.com](https://vercel.com) → **Add New Project** (o actualiza el existente)
2. Importa el repositorio `trazea-auth`
3. Framework Preset: **Next.js** (auto-detectado)
4. **Variables de entorno**: Añade en Vercel:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `NEXT_PUBLIC_APP_SCHEME`
5. Haz clic en **Deploy**

### 3. Añadir dominio personalizado

1. En Vercel → Settings → Domains → añade `auth.trazea.es`
2. En tu DNS (donde gestiones `trazea.es`) añade:
   ```
   CNAME  auth  cname.vercel-dns.com
   ```
3. Vercel provisionará el certificado TLS automáticamente

---

## Configuración en Supabase

Una vez desplegado en `https://auth.trazea.es`:

**Authentication → URL Configuration:**

| Campo | Valor |
|-------|-------|
| Site URL | `https://auth.trazea.es` |
| Redirect URLs | `trazea://**` |

---

## Estructura del proyecto

```
trazea-auth/
├── src/
│   ├── app/           # Next.js App Router
│   │   ├── layout.tsx
│   │   ├── page.tsx   # Página principal
│   │   └── globals.css
│   └── lib/
│       └── supabase.ts
├── public/
│   └── logo.svg
├── next.config.ts
├── package.json
└── vercel.json
```

## Flujo de usuario

1. Admin invita a un usuario desde la app → Supabase envía email
2. Usuario hace clic en el enlace → llega a `https://auth.trazea.es/#access_token=...&type=invite`
3. La página establece la sesión con Supabase y muestra el formulario
4. Usuario introduce su contraseña y la guarda
5. Pantalla de éxito con botón **Abrir Trazea** (`trazea://`)
