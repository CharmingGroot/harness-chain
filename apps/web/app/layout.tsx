import type { Metadata } from "next";
import "./globals.css";
import { JobProvider } from "./job-context";

export const metadata: Metadata = {
  title: "HarnessChain — AI 업무 자동화 플랫폼",
  description: "업무 프로세스를 하네스 템플릿으로 변환하고 소스·도구·서브에이전트를 체인으로 실행",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className="h-full">
      <body className="h-full">
        <JobProvider>
          {children}
        </JobProvider>
      </body>
    </html>
  );
}
