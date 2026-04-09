"""
인터랙티브 3D 뷰어로 가우시안 입자를 수동 선택한다.

두 가지 도구:
  - BBox  : 슬라이더로 3D 박스 범위를 조절해 내부 입자를 선택한다.
  - Paint : 브러쉬로 칠해 입자를 선택한다. (∪ / ∩ / - 모드)
             페인팅 중에는 3D 회전이 비활성화된다.

사용법:
    from select_gaussians.manual import select_gaussians
    indices = select_gaussians("path/to/scene.ply")
"""

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.widgets import RadioButtons, Slider, Button
from mpl_toolkits.mplot3d import proj3d, Axes3D


# ---------- PLY 로더 ----------

def load_ply_xyz(ply_path: str) -> np.ndarray:
    """
    PLY 파일에서 가우시안 입자의 xyz 좌표를 로드한다.

    Args:
        ply_path: PLY 파일 경로

    Returns:
        (N, 3) xyz 좌표 배열
    """
    from plyfile import PlyData
    ply = PlyData.read(ply_path)
    v   = ply['vertex']
    return np.column_stack([v['x'], v['y'], v['z']]).astype(np.float64)


# ---------- 선택 도구 ----------

class ManualSelector:
    """
    인터랙티브 3D 뷰어로 가우시안 입자를 수동 선택한다.

    Args:
        xyz: (N, 3) 가우시안 입자의 xyz 좌표
    """

    _C_DEFAULT  = [0.65, 0.65, 0.65, 0.25]  # 비선택: 회색 반투명
    _C_SELECTED = [1.00, 1.00, 0.00, 0.95]  # 선택됨: 노란색 형광

    def __init__(self, xyz: np.ndarray):
        self.xyz      = np.asarray(xyz, dtype=np.float64)
        self.N        = len(self.xyz)
        self.selected = np.zeros(self.N, dtype=bool)
        self._history: list[np.ndarray] = []

        self.tool       = "bbox"   # "bbox" | "paint"
        self.paint_mode = "union"  # "union" | "inter" | "diff"
        self.brush_size = 20       # pixels
        self._painting  = False
        self._rclick_start: tuple[float, float, float, float] | None = None  # (x, y, elev, azim)

        self._build_ui()

    # ── UI 구성 ──────────────────────────────────────────────

    def _build_ui(self):
        self.fig = plt.figure(figsize=(14, 8))
        self.fig.suptitle("Gaussian Selector  |  선택: 0 개", fontsize=11)

        # 3D 뷰 (Axes3D로 명시적 캐스팅)
        self.ax: Axes3D = self.fig.add_axes(  # type: ignore[assignment]
            (0.01, 0.28, 0.63, 0.68), projection="3d"
        )
        colors  = [self._C_DEFAULT] * self.N
        self._sc = self.ax.scatter(*self.xyz.T, c=colors, s=2)
        self.ax.set_xlabel("X"); self.ax.set_ylabel("Y"); self.ax.set_zlabel("Z")
        self.ax.disable_mouse_rotation()  # 기본 회전 비활성화 → 오른쪽 드래그로 직접 구현

        self._build_right_panel()
        self._build_bbox_sliders()
        self._connect_events()
        self._refresh()

    def _build_right_panel(self):
        # 도구 선택
        ax_tool = self.fig.add_axes((0.67, 0.77, 0.13, 0.11))
        ax_tool.set_title("도구", fontsize=9)
        self._radio_tool = RadioButtons(ax_tool, ["BBox", "Paint"], active=0)
        self._radio_tool.on_clicked(self._on_tool_change)

        # 페인팅 모드
        ax_mode = self.fig.add_axes((0.67, 0.55, 0.30, 0.18))
        ax_mode.set_title("페인팅 모드", fontsize=9)
        self._radio_mode = RadioButtons(
            ax_mode, ["∪  합집합 (추가)", "∩  교집합 (남기기)", "-  차집합 (제거)"], active=0
        )
        self._radio_mode.on_clicked(self._on_mode_change)

        # 브러쉬 크기
        ax_brush = self.fig.add_axes((0.67, 0.46, 0.27, 0.03))
        self._sl_brush = Slider(ax_brush, "브러쉬", 5, 120, valinit=20, valstep=1)
        self._sl_brush.on_changed(lambda v: setattr(self, "brush_size", int(v)))

        # 버튼
        for label, rect, cb in [
            ("Reset", (0.67, 0.37, 0.12, 0.05), self._on_reset),
            ("Undo",  (0.82, 0.37, 0.12, 0.05), self._on_undo),
            ("Done",  (0.67, 0.29, 0.27, 0.06), self._on_done),
        ]:
            ax_b = self.fig.add_axes(rect)
            btn  = Button(ax_b, label)
            btn.on_clicked(cb)
            setattr(self, f"_btn_{label.lower()}", btn)  # GC 방지

    def _build_bbox_sliders(self):
        mins = self.xyz.min(axis=0)
        maxs = self.xyz.max(axis=0)
        self._sl_bbox: dict[str, Slider] = {}
        specs = [
            ("X min", mins[0], maxs[0], mins[0]),
            ("X max", mins[0], maxs[0], maxs[0]),
            ("Y min", mins[1], maxs[1], mins[1]),
            ("Y max", mins[1], maxs[1], maxs[1]),
            ("Z min", mins[2], maxs[2], mins[2]),
            ("Z max", mins[2], maxs[2], maxs[2]),
        ]
        for i, (lbl, lo, hi, init) in enumerate(specs):
            col  = i % 3
            row  = i // 3
            rect = (0.05 + col * 0.21, 0.14 - row * 0.09, 0.17, 0.03)
            ax_s = self.fig.add_axes(rect)
            sl   = Slider(ax_s, lbl, lo, hi, valinit=init)
            sl.on_changed(self._on_bbox_change)
            self._sl_bbox[lbl] = sl

    # ── 이벤트 ──────────────────────────────────────────────

    def _connect_events(self):
        c = self.fig.canvas
        self._cid_press   = c.mpl_connect("button_press_event",   self._on_press)
        self._cid_move    = c.mpl_connect("motion_notify_event",  self._on_move)
        self._cid_release = c.mpl_connect("button_release_event", self._on_release)

    def _on_tool_change(self, label: str | None):
        if label is None:
            return
        self.tool = "bbox" if label == "BBox" else "paint"
        if self.tool != "paint":
            self._update_bbox_selection()

    def _on_mode_change(self, label: str | None):
        if label is None:
            return
        if "합집합" in label:   self.paint_mode = "union"
        elif "교집합" in label: self.paint_mode = "inter"
        else:                   self.paint_mode = "diff"

    def _on_bbox_change(self, _):
        if self.tool == "bbox":
            self._update_bbox_selection()

    def _on_press(self, event):
        if event.inaxes != self.ax:
            return
        if event.button == 3:  # 오른쪽 클릭: 회전 시작
            self._rclick_start = (event.x, event.y, self.ax.elev, self.ax.azim)
            return
        if self.tool != "paint" or event.button != 1:
            return
        self._push_history()
        self._painting = True
        self._apply_brush(event)

    def _on_move(self, event):
        if self._rclick_start is not None and event.inaxes == self.ax:
            x0, y0, elev0, azim0 = self._rclick_start
            self.ax.elev = elev0 - (event.y - y0) * 0.3
            self.ax.azim = azim0 - (event.x - x0) * 0.3
            self.fig.canvas.draw_idle()
            return
        if self._painting and event.inaxes == self.ax:
            self._apply_brush(event)

    def _on_release(self, event):
        if event.button == 3:
            self._rclick_start = None
            return
        self._painting = False

    def _on_reset(self, _):
        self._push_history()
        self.selected[:] = False
        self._refresh()

    def _on_undo(self, _):
        if self._history:
            self.selected = self._history.pop()
            self._refresh()

    def _on_done(self, _):
        plt.close(self.fig)

    # ── 선택 로직 ────────────────────────────────────────────

    def _update_bbox_selection(self):
        sl = self._sl_bbox
        self.selected = (
            (self.xyz[:, 0] >= sl["X min"].val) & (self.xyz[:, 0] <= sl["X max"].val) &
            (self.xyz[:, 1] >= sl["Y min"].val) & (self.xyz[:, 1] <= sl["Y max"].val) &
            (self.xyz[:, 2] >= sl["Z min"].val) & (self.xyz[:, 2] <= sl["Z max"].val)
        )
        self._refresh()

    def _apply_brush(self, event):
        """현재 시점에서 마우스 주변 브러쉬 범위의 점들에 선택 모드를 적용한다."""
        x2d, y2d, _ = proj3d.proj_transform(
            self.xyz[:, 0], self.xyz[:, 1], self.xyz[:, 2],
            self.ax.get_proj()
        )
        pts_disp   = self.ax.transData.transform(np.column_stack([x2d, y2d]))
        mouse_disp = np.array([event.x, event.y])
        brushed    = np.linalg.norm(pts_disp - mouse_disp, axis=1) < self.brush_size

        if   self.paint_mode == "union": self.selected |=  brushed
        elif self.paint_mode == "inter": self.selected &=  brushed
        else:                            self.selected &= ~brushed

        self._refresh()

    # ── 시각화 ───────────────────────────────────────────────

    def _refresh(self):
        colors = np.where(
            self.selected[:, None],
            self._C_SELECTED,
            self._C_DEFAULT,
        ).astype(np.float64)
        self._sc.set_facecolor(colors)  # type: ignore[arg-type]
        self._sc.set_edgecolor(colors)  # type: ignore[arg-type]
        self._sc._facecolor3d = self._sc.get_facecolor()  # type: ignore[attr-defined]
        self._sc._edgecolor3d = self._sc.get_edgecolor()  # type: ignore[attr-defined]
        n_sel = int(self.selected.sum())
        self.fig.suptitle(
            f"Gaussian Selector  |  선택: {n_sel:,} 개  /  전체: {self.N:,} 개",
            fontsize=11,
        )
        self.fig.canvas.draw_idle()

    def _push_history(self):
        self._history.append(self.selected.copy())
        if len(self._history) > 20:
            self._history.pop(0)

    # ── 실행 ─────────────────────────────────────────────────

    def run(self) -> np.ndarray:
        """
        뷰어를 실행하고 Done을 누르면 선택된 입자의 인덱스를 반환한다.

        Returns:
            (N,) 선택된 입자의 인덱스 배열
        """
        plt.show()
        return np.where(self.selected)[0]


# ---------- 편의 함수 ----------

def select_gaussians(ply_path: str) -> np.ndarray:
    """
    PLY 파일을 로드하고 인터랙티브 뷰어로 입자를 선택해 인덱스를 반환한다.

    Args:
        ply_path: PLY 파일 경로

    Returns:
        선택된 가우시안 입자의 인덱스 배열 (N,)
    """
    xyz = load_ply_xyz(ply_path)
    print(f"로드 완료: {len(xyz):,} 개의 입자")
    return ManualSelector(xyz).run()


if __name__ == "__main__":
    import sys

    if len(sys.argv) >= 2:
        indices = select_gaussians(sys.argv[1])
    else:
        # PLY 없을 때: 랜덤 점군 + 문 모양 테스트
        rng  = np.random.default_rng(0)
        bg   = rng.uniform(-1, 1, (3_000, 3))
        door = rng.uniform([0.0, 0.0, -0.02], [1.0, 2.0, 0.02], (2_000, 3))
        xyz  = np.vstack([bg, door])
        indices = ManualSelector(xyz).run()

    print(f"\n선택된 입자: {len(indices):,} 개")
    if len(indices):
        print(f"인덱스 범위: {indices.min()} ~ {indices.max()}")
