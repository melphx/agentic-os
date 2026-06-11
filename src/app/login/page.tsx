'use client'
import { useState } from 'react'
import { motion } from 'framer-motion'

export default function LoginPage() {
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(false)

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true); setError('')
    try {
      const res  = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Login failed'); return }
      window.location.href = '/'
    } catch { setError('Network error') }
    finally { setLoading(false) }
  }

  const inputStyle = {
    width: '100%', padding: '10px 14px', borderRadius: 10,
    background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.25)',
    color: 'white', fontSize: 14, outline: 'none', boxSizing: 'border-box' as const,
    fontFamily: 'Inter, sans-serif',
  }

  return (
    <div style={{
      minHeight: '100vh', background: '#080c14', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      fontFamily: 'Inter, system-ui, sans-serif',
    }}>
      {/* Grid background */}
      <div style={{
        position: 'fixed', inset: 0, pointerEvents: 'none',
        backgroundImage: 'linear-gradient(rgba(99,102,241,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,0.04) 1px, transparent 1px)',
        backgroundSize: '40px 40px',
      }} />

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        style={{ position: 'relative', width: '100%', maxWidth: 380, margin: '0 16px' }}
      >
        {/* Glow border */}
        <div style={{
          position: 'absolute', inset: -1, borderRadius: 20,
          background: 'linear-gradient(135deg, rgba(99,102,241,0.35), rgba(168,85,247,0.2))',
          filter: 'blur(1px)',
        }} />

        <div style={{
          position: 'relative', borderRadius: 20, padding: '36px 32px',
          background: 'rgba(15,20,35,0.97)',
          border: '1px solid rgba(99,102,241,0.2)',
          backdropFilter: 'blur(20px)',
        }}>
          {/* Logo */}
          <div style={{ textAlign: 'center', marginBottom: 32 }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 88, height: 88, borderRadius: 20, marginBottom: 16, overflow: 'hidden',
              boxShadow: '0 0 32px rgba(99,102,241,0.35)',
            }}>
              <img src="/phr-logo.png" alt="PHR OS" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </div>
            <h1 style={{ color: 'white', fontWeight: 800, fontSize: 24, margin: 0, letterSpacing: '-0.02em' }}>PHR OS</h1>
            <p style={{ color: 'rgba(148,163,184,0.6)', fontSize: 13, margin: '6px 0 0' }}>Mission Control · Sign in</p>
          </div>

          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'rgba(148,163,184,0.7)', marginBottom: 6, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                Email
              </label>
              <input
                type="email" value={email} onChange={e => setEmail(e.target.value)}
                required placeholder="admin@example.com" style={inputStyle}
                onFocus={e => (e.target.style.borderColor = 'rgba(99,102,241,0.7)')}
                onBlur={e  => (e.target.style.borderColor = 'rgba(99,102,241,0.25)')}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'rgba(148,163,184,0.7)', marginBottom: 6, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                Password
              </label>
              <input
                type="password" value={password} onChange={e => setPassword(e.target.value)}
                required placeholder="••••••••" style={inputStyle}
                onFocus={e => (e.target.style.borderColor = 'rgba(99,102,241,0.7)')}
                onBlur={e  => (e.target.style.borderColor = 'rgba(99,102,241,0.25)')}
              />
            </div>

            {error && (
              <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
                style={{ fontSize: 13, padding: '10px 14px', borderRadius: 9, background: 'rgba(244,63,94,0.12)', color: '#f43f5e', border: '1px solid rgba(244,63,94,0.25)' }}>
                {error}
              </motion.div>
            )}

            <motion.button
              type="submit" disabled={loading}
              whileHover={{ scale: loading ? 1 : 1.01 }}
              whileTap={{ scale: loading ? 1 : 0.99 }}
              style={{
                width: '100%', padding: '11px 0', borderRadius: 10, border: 'none',
                fontSize: 14, fontWeight: 700, color: 'white', cursor: loading ? 'not-allowed' : 'pointer',
                background: loading ? 'rgba(99,102,241,0.35)' : 'linear-gradient(135deg, #6366f1, #a855f7)',
                boxShadow: loading ? 'none' : '0 0 24px rgba(99,102,241,0.35)',
                marginTop: 4, fontFamily: 'Inter, sans-serif',
              }}
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </motion.button>
          </form>

          <p style={{ textAlign: 'center', fontSize: 11, color: 'rgba(148,163,184,0.35)', marginTop: 24, marginBottom: 0 }}>
            PHR OS · Powered by Hermes
          </p>
        </div>
      </motion.div>
    </div>
  )
}
