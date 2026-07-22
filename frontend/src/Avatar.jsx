// Uploaded picture, or a stable gradient + initial derived from the username.
export default function Avatar({ user, size = 44, online = null }) {
  const name = user?.username || '?'
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0) * 7, 0) % 360
  return (
    <div className="avatar" style={{ width: size, height: size }}>
      {user?.avatar ? (
        <img src={user.avatar} alt="" draggable="false" />
      ) : (
        <div
          className="avatar-fallback"
          style={{
            background: `linear-gradient(135deg, hsl(${hue} 70% 52%), hsl(${(hue + 45) % 360} 72% 40%))`,
            fontSize: size * 0.42,
          }}
        >
          {name[0].toUpperCase()}
        </div>
      )}
      {online !== null && <span className={`presence-dot ${online ? 'on' : ''}`} />}
    </div>
  )
}
