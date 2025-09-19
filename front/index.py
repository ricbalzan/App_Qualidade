# index.py — Visualização de Fotos (filtro por DATA única)
# - Sidebar: LOGO + "Filtro de data" com "Escolha a data" (sem intervalo)
# - Lista apenas os .zip do diretório raiz com a data escolhida
# - Miniaturas clicáveis (mesma guia) e visualização grande em modal/dialog
# - Tema claro: conteúdo branco e sidebar cinza

import io
import base64
import re
from datetime import date
from pathlib import Path
from urllib.parse import quote, unquote
import zipfile
import streamlit as st
from PIL import Image
import streamlit.components.v1 as components 

# ------------- Aparência / CSS -------------
st.set_page_config(page_title="Visualização de Fotos", layout="wide")
st.markdown("""
<style>
/* Hover azul claro nos botões do sidebar (lista de ZIPs) */
[data-testid="stSidebar"] .stButton > button {
  transition: background-color .15s ease, border-color .15s ease, transform .1s ease;
}
[data-testid="stSidebar"] .stButton > button:hover {
  background: #e0f2fe !important;   /* azul claro */
  border-color: #38bdf8 !important; /* ciano */
  color: #0c4a6e !important;        /* texto azul escuro */
  transform: translateY(-1px);
}
[data-testid="stSidebar"] .stButton > button:active {
  transform: translateY(0);
}
[data-testid="stSidebar"] .stButton > button:focus {
  outline: 2px solid #38bdf8 !important;
  outline-offset: 2px;
}
</style>
""", unsafe_allow_html=True)

# ---- Auto-reload a cada 5 minutos (300.000 ms)
components.html(
    "<script>setTimeout(() => window.location.reload(), 300000);</script>",
    height=0,
)


# ------------- Config -------------
THUMB_PX = 144
MAX_IMGS = 120
IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
DATE_RE = re.compile(r"^(\d{4})[-_/](\d{2})[-_/](\d{2})")  # data no início do nome do .zip
default_root = r"\\10.0.2.1\dados\Qualidade\FOTOS"  # ajuste se necessário

# ------------- Utilitários -------------
def parse_date_from_name(name: str):
    m = DATE_RE.match(name.strip())
    if not m:
        return None
    try:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except Exception:
        return None

@st.cache_data(show_spinner=False, ttl=300)
def scan_zip_index(root: str):
    """Indexa .zip SOMENTE no diretório raiz: caminho, nome e data (por nome ou mtime)."""
    root_path = Path(root)
    if not root_path.exists():
        return []
    items = []
    for p in root_path.glob("*.zip"):  # sem subpastas
        d = parse_date_from_name(p.name) or date.fromtimestamp(p.stat().st_mtime)
        items.append({"full": str(p), "name": p.name, "date": d})
    return items

def build_files_for_date(index_items, selected_date: date):
    """Retorna nomes dos zips cuja data == selected_date."""
    return sorted([it["name"] for it in index_items if it["date"] == selected_date])

def render_zip_list(container, files, base: Path):
    for fname in files:
        full_path = str(base / fname)
        if container.button(fname, key=f"zipbtn_{full_path}"):
            st.session_state["selected_zip"] = full_path
            st.session_state.pop("viewer", None)

@st.cache_data(show_spinner=False)
def zip_gallery(zip_path: str, thumb_px: int, max_imgs: int, mtime: float):
    thumbs, total = [], 0
    with zipfile.ZipFile(zip_path, "r") as z:
        for info in z.infolist():
            if info.is_dir(): continue
            if Path(info.filename).suffix.lower() not in IMG_EXTS: continue
            total += 1
            if len(thumbs) >= max_imgs: continue
            try:
                data = z.read(info)
                img = Image.open(io.BytesIO(data)).convert("RGB")
                img.thumbnail((thumb_px, thumb_px))
                buf = io.BytesIO(); img.save(buf, format="PNG")
                thumbs.append({"name": info.filename, "thumb": buf.getvalue()})
            except Exception:
                pass
    return thumbs, total

def read_image_from_zip(zip_path: str, inner_name: str) -> bytes:
    with zipfile.ZipFile(zip_path, "r") as z:
        return z.read(inner_name)

def get_query_params():
    try: return dict(st.query_params)
    except Exception: return dict(st.experimental_get_query_params())

def clear_query_params():
    try: st.query_params.clear()
    except Exception: st.experimental_set_query_params()

def find_logo_path():
    """Logo fora de /front: ../img/logo1.png primeiro; depois alternativas."""
    here = Path(__file__).parent
    parent = here.parent
    for p in [parent/"img/logo1.png", Path.cwd().parent/"img/logo1.png",
              here/"img/logo1.png", Path("img/logo1.png")]:
        try:
            if p.exists(): return str(p)
        except Exception:
            pass
    return None

# ------------- Sidebar -------------
with st.sidebar:
    # logo no topo
    logo_path = find_logo_path()
    if logo_path:
        st.image(logo_path, use_container_width=True)
    else:
        st.write("")

    # índice e datas disponíveis
    idx = scan_zip_index(default_root)
    if idx:
        all_dates = sorted({it["date"] for it in idx})
        default_date = max(all_dates)
    else:
        all_dates = []
        default_date = date.today()

    st.markdown("### Filtro de data")
    selected_date = st.date_input("Escolha a data", value=default_date)

    st.markdown("### Arquivos (.zip) no diretório")
    root = Path(default_root)
    if root.exists():
        files = build_files_for_date(idx, selected_date)
        if files:
            render_zip_list(st.sidebar, files, root)
        else:
            st.info("Nenhum .zip para a data selecionada.")
    else:
        st.info("Caminho não encontrado.")

# ------------- Conteúdo -------------
st.title("Visualização de Fotos")
st.markdown("---")
st.subheader("Pré-visualização do conteúdo")

# Suporte a abrir direto via query string (?open=...&img=...)
qp = get_query_params()
if "open" in qp and "img" in qp:
    try:
        st.session_state["selected_zip"] = unquote(qp["open"])
        st.session_state["viewer"] = {"zip": unquote(qp["open"]), "name": unquote(qp["img"])}
    finally:
        clear_query_params()

if "selected_zip" not in st.session_state:
    st.info("Selecione um arquivo .zip na lista à esquerda.")
else:
    zip_path = st.session_state["selected_zip"]
    try:
        mtime = Path(zip_path).stat().st_mtime
    except FileNotFoundError:
        st.warning("Arquivo não encontrado."); st.stop()

    with st.spinner("Gerando miniaturas..."):
        thumbs, total = zip_gallery(zip_path, THUMB_PX, MAX_IMGS, mtime)

    if not thumbs:
        st.warning("Nenhuma imagem suportada encontrada neste ZIP.")
    else:
        cols_per_row = max(1, min(8, 1200 // THUMB_PX))
        cols = st.columns(cols_per_row)
        for i, t in enumerate(thumbs):
            b64 = base64.b64encode(t["thumb"]).decode()
            qs = f'?open={quote(zip_path)}&img={quote(t["name"])}'
            html = f"""
            <a class="thumb-link" href="{qs}" target="_self" title="Abrir">
              <img class="thumb" src="data:image/png;base64,{b64}" width="{THUMB_PX}"
                   style="border-radius:10px;display:block;margin-bottom:10px;">
            </a>
            """
            with cols[i % cols_per_row]:
                st.markdown(html, unsafe_allow_html=True)

        st.caption(f"Exibindo {len(thumbs)} de {total} imagem(ns).")

# ------------- Visualização grande -------------
viewer = st.session_state.get("viewer")
if viewer:
    try:
        img_bytes = read_image_from_zip(viewer["zip"], viewer["name"])
        filename = Path(viewer["name"]).name

        if hasattr(st, "modal"):
            with st.modal("Visualização"):
                st.image(img_bytes, use_container_width=True)
                left, mid, right = st.columns([1,2,1])
                with mid:
                    st.download_button("⬇️  Baixar imagem", data=img_bytes, file_name=filename, key="dl_modal")
        elif hasattr(st, "dialog"):
            @st.dialog("Visualização")
            def _dlg(bts):
                st.image(bts, use_container_width=True)
                left, mid, right = st.columns([1,2,1])
                with mid:
                    st.download_button("⬇️  Baixar imagem", data=bts, file_name=filename, key="dl_dialog")
            _dlg(img_bytes)
        else:
            st.markdown("#### Visualização")
            st.image(img_bytes, use_container_width=True)
            left, mid, right = st.columns([1,2,1])
            with mid:
                st.download_button("⬇️  Baixar imagem", data=img_bytes, file_name=filename, key="dl_inline")
    except Exception as e:
        st.error(f"Erro ao abrir a imagem: {e}")
        st.session_state.pop("viewer", None)
