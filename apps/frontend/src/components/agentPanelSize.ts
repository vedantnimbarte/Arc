/** Footprint of the rendered agent launch panel, kept apart from
 *  `AgentLauncher` so the surfaces that anchor it (the top-bar button, the
 *  launcher's entry) can keep it inside the viewport without pulling the panel
 *  into the startup bundle. Approximate on purpose — a few pixels out just
 *  shifts the clamp, and the hosts pair it with a `max-h` backstop. */
export const AGENT_PANEL_W = 318;
export const AGENT_PANEL_H = 620;
