import { createRouter, createWebHistory } from "vue-router";
import InboxPage from "./pages/InboxPage.vue";
import ConsolePage from "./pages/ConsolePage.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/inbox" },
    { path: "/inbox", component: InboxPage },
    { path: "/console/:conversationId", component: ConsolePage },
    { path: "/:pathMatch(.*)*", redirect: "/inbox" }
  ]
});

export default router;

