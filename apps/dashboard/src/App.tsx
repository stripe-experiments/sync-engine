import { useState } from 'react'
import { PipelineList } from './pages/PipelineList'
import { PipelineCreate } from './pages/PipelineCreate'
import { PipelineDetail } from './pages/PipelineDetail'

type Page = { view: 'list' } | { view: 'create' } | { view: 'detail'; id: string }

export default function App() {
  const [page, setPage] = useState<Page>({ view: 'list' })

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b bg-white px-8 py-4">
        <button
          onClick={() => setPage({ view: 'list' })}
          className="text-lg font-semibold text-gray-900 hover:text-indigo-600"
        >
          Stripe Sync
        </button>
      </header>
      <main>
        {page.view === 'list' && (
          <PipelineList
            onSelect={(id) => setPage({ view: 'detail', id })}
            onCreate={() => setPage({ view: 'create' })}
          />
        )}
        {page.view === 'create' && (
          <PipelineCreate onDone={() => setPage({ view: 'list' })} />
        )}
        {page.view === 'detail' && (
          <PipelineDetail id={page.id} onBack={() => setPage({ view: 'list' })} />
        )}
      </main>
    </div>
  )
}
