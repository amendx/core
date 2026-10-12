import {
  createRouter as _createRouter,
  createMemoryHistory,
  createWebHistory,
} from 'vue-router'
import Home from './pages/Home.vue'

// The smoke runner visits every record here. Records with params need
// `meta.smokePath`; `meta.status` is the expected HTTP status (default 200).
export const routes = [
  { path: '/', name: 'home', component: Home },
  {
    path: '/async',
    name: 'async',
    component: () => import('./pages/AsyncPage.vue'),
  },
  {
    path: '/suspense',
    name: 'suspense',
    component: () => import('./pages/SuspensePage.vue'),
  },
  {
    path: '/lazy',
    name: 'lazy',
    component: () => import('./pages/LazyPage.vue'),
  },
  {
    path: '/teleport',
    name: 'teleport',
    component: () => import('./pages/TeleportPage.vue'),
  },
  {
    path: '/users/:id',
    name: 'user',
    component: () => import('./pages/UserPage.vue'),
    meta: { smokePath: '/users/42' },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('./pages/NotFound.vue'),
    meta: { smokePath: '/does/not/exist', status: 404 },
  },
]

export function createRouter() {
  return _createRouter({
    history: import.meta.env.SSR ? createMemoryHistory() : createWebHistory(),
    routes,
  })
}
