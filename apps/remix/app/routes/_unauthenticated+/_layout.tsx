import backgroundPattern from '@documenso/assets/images/background-pattern.png';
import { motion } from 'framer-motion';
import { Outlet } from 'react-router';

import { PublicLegalLinks } from '~/components/general/public-legal-links';

export default function Layout() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-between overflow-hidden px-4 py-12 md:p-12 lg:p-24">
      <div className="flex w-full flex-1 flex-col items-center justify-center">
        <div className="absolute inset-0 -z-10 overflow-hidden">
          {/* Background pattern */}
          <motion.div
            className="flex h-full w-full items-center justify-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.4, transition: { duration: 0.5, delay: 0.5 } }}
          >
            <img
              src={backgroundPattern}
              alt="background pattern"
              className="-mt-[15vh] -ml-[50vw] h-full scale-125 object-cover md:scale-150 lg:scale-[175%] dark:contrast-[70%] dark:invert dark:sepia"
            />
          </motion.div>
        </div>

        <div className="relative flex w-full items-center justify-center">
          <Outlet />
        </div>
      </div>

      <footer className="z-10 mt-8 w-full">
        <PublicLegalLinks />
      </footer>
    </main>
  );
}
