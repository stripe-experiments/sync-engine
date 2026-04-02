import { PipelineCreate } from './pages/PipelineCreate'

export default function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b bg-white px-8 py-4">
        <h1 className="text-lg font-semibold text-gray-900">Stripe Sync</h1>
      </header>
      <main>
        <PipelineCreate />
      </main>
    </div>
  )
}
